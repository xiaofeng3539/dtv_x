// 房间加载和 sdk_key 流映射参考移植自 dart_simple_live/simple_live_core/lib/src/douyin_site.dart。
// 参考项目采用 GPL-3.0；分发包含派生实现的版本时须履行 GPL 的许可及对应源码提供要求。
use crate::platforms::common::http_client::HttpClient;
use crate::platforms::douyin::a_bogus::generate_a_bogus;
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, REFERER, SET_COOKIE, USER_AGENT,
};
use serde_json::Value;
use std::time::Duration;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400";
const LIVE_BASE: &str = "https://live.douyin.com";
// Simple Live uses this public visitor session before obtaining a refreshed one.
const DEFAULT_COOKIE: &str = "ttwid=1%7CB1qls3GdnZhUov9o2NxOMxxYS2ff6OSvEWbv0ytbES4%7C1680522049%7C280d802d6d478e3e78d0c807f7c487e7ffec0ae4e5fdd6a0fe74c3c6af149511";
#[derive(Clone, Copy)]
struct RoomTimeouts { api: Duration, cookie: Duration, page: Duration }
const PLAYBACK_TIMEOUTS: RoomTimeouts = RoomTimeouts {
    api: Duration::from_secs(20), cookie: Duration::from_secs(20), page: Duration::from_secs(20),
};
const FOLLOW_TIMEOUTS: RoomTimeouts = RoomTimeouts {
    api: Duration::from_secs(3), cookie: Duration::from_secs(1), page: Duration::from_secs(4),
};
// Bound the complete fallback chain; the frontend allows both room-query attempts.
const ROOM_TIMEOUT: Duration = Duration::from_secs(40);
const FOLLOW_ROOM_TIMEOUT: Duration = Duration::from_secs(9);

#[derive(Debug, Clone)]
pub struct DouyinRoomData {
    pub room: Value,
}

pub fn room_status(room: &Value) -> Result<i32, String> {
    room.get("status")
        .and_then(Value::as_i64)
        .filter(|status| matches!(*status, 2 | 4))
        .and_then(|status| i32::try_from(status).ok())
        .ok_or_else(|| "抖音房间数据缺少有效直播状态".to_string())
}

#[derive(Debug, Clone)]
pub struct DouyinStream {
    pub key: String,
    pub name: String,
    pub level: i64,
    pub url: String,
    pub format: &'static str,
}

fn request_headers(referer: &str, cookies: Option<&str>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    headers.insert(
        REFERER,
        HeaderValue::from_str(referer).map_err(|e| e.to_string())?,
    );
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    // Same cold-start headers as Simple Live; refreshed cookies take precedence below.
    let cookie = cookies.filter(|cookie| !cookie.trim().is_empty()).unwrap_or(DEFAULT_COOKIE);
    {
        headers.insert(
            COOKIE,
            HeaderValue::from_str(cookie).map_err(|e| e.to_string())?,
        );
    }
    Ok(headers)
}

fn merge_cookies(original: Option<&str>, updates: &HeaderMap) -> String {
    let mut values = std::collections::BTreeMap::new();
    for entry in original.unwrap_or_default().split(';') {
        let entry = entry.trim();
        if let Some((key, _)) = entry.split_once('=') {
            values.insert(key.to_string(), entry.to_string());
        }
    }
    for value in updates.get_all(SET_COOKIE) {
        let Some(entry) = value
            .to_str()
            .ok()
            .and_then(|value| value.split(';').next())
        else {
            continue;
        };
        let entry = entry.trim();
        if let Some((key, _)) = entry.split_once('=') {
            if matches!(key, "ttwid" | "__ac_nonce" | "msToken") {
                values.insert(key.to_string(), entry.to_string());
            }
        }
    }
    values.into_values().collect::<Vec<_>>().join("; ")
}

async fn refresh_web_cookie(http: &HttpClient, page: &str, cookies: Option<&str>, timeout: Duration) -> String {
    match request_headers(page, cookies) {
        Ok(headers) => match http.inner.head(page).headers(headers).timeout(timeout).send().await {
            // HEAD 即使返回 404 也可能发放访客会话。
            Ok(response) => merge_cookies(cookies, response.headers()),
            Err(_) => cookies.unwrap_or_default().to_string(),
        },
        Err(_) => cookies.unwrap_or_default().to_string(),
    }
}

#[derive(Debug)]
struct RoomApiError {
    message: String,
    refresh_session: bool,
}

async fn request_api_room(
    http: &HttpClient,
    api: &str,
    referer: &str,
    cookies: Option<&str>,
    timeout: Duration,
) -> Result<DouyinRoomData, RoomApiError> {
    let headers = request_headers(referer, cookies).map_err(|message| RoomApiError {
        message,
        refresh_session: false,
    })?;
    let response = http
        .inner
        .get(api)
        .headers(headers)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| RoomApiError {
            message: format!("抖音接口请求失败：{e}"),
            refresh_session: false,
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(RoomApiError {
            message: format!("抖音接口返回 HTTP {status}"),
            refresh_session: status.as_u16() == 444,
        });
    }
    let json: Value = response.json().await.map_err(|e| RoomApiError {
        message: format!("抖音接口未返回有效 JSON：{e}"),
        refresh_session: true,
    })?;
    let mut room = json
        .pointer("/data/data/0")
        .filter(|room| room.is_object())
        .cloned()
        .ok_or_else(|| RoomApiError {
            message: "抖音接口未返回有效房间数据".into(),
            refresh_session: true,
        })?;
    room_status(&room).map_err(|message| RoomApiError {
        message,
        refresh_session: room.get("status").and_then(Value::as_i64).is_none(),
    })?;
    if let Some(user) = json.pointer("/data/user").filter(|user| user.is_object()) {
        let object = room.as_object_mut().unwrap();
        if object.get("owner").map_or(true, |owner| !owner.is_object()) {
            object.insert("anchor".into(), user.clone());
        }
    }
    if let Some(info) = json.get("data") {
        crate::platforms::common::follow_metadata::preserve_douyin_partition(&mut room, info);
    }
    Ok(DouyinRoomData { room })
}

fn signed_api_url(api: &str, query: &str) -> String {
    use rand::distr::{Alphanumeric, SampleString};
    let token = Alphanumeric.sample_string(&mut rand::rng(), 107);
    let query = format!("{query}&msToken={token}");
    let signature = generate_a_bogus(&query, DEFAULT_USER_AGENT);
    format!("{api}?{query}&a_bogus={}", urlencoding::encode(&signature))
}

pub(crate) fn active_cookie(http: &HttpClient, page: &str, cookies: Option<&str>) -> String {
    let configured = cookies.filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_COOKIE);
    let Some(cached) = http.cookie_header(page) else { return configured.into(); };
    let mut updates = HeaderMap::new();
    if let Ok(cached) = cached.to_str() {
        for part in cached.split(';') {
            if let Ok(value) = HeaderValue::from_str(part.trim()) { updates.append(SET_COOKIE, value); }
        }
    }
    merge_cookies(Some(configured), &updates)
}

async fn fetch_room_from_api(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
    timeouts: RoomTimeouts,
) -> Result<DouyinRoomData, (String, String)> {
    let active = active_cookie(http, base, cookies);
    let cookies = Some(active.as_str());
    let referer = format!("{base}/{id}");
    let api = format!("{base}/webcast/room/web/enter/");
    let params = [
        ("aid", "6383"),
        ("app_name", "douyin_web"),
        ("live_id", "1"),
        ("device_platform", "web"),
        ("language", "zh-CN"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Chrome"),
        ("browser_version", "125.0.0.0"),
        ("web_rid", id),
    ];
    let query = serde_urlencoded::to_string(params)
        .map_err(|e| (e.to_string(), cookies.unwrap_or_default().to_string()))?;
    match request_api_room(http, &signed_api_url(&api, &query), &referer, cookies, timeouts.api).await {
        Ok(room) => Ok(room),
        Err(error) if error.refresh_session => {
            let refreshed = refresh_web_cookie(http, &format!("{base}/"), cookies, timeouts.cookie).await;
            let cookies = if refreshed.is_empty() {
                cookies
            } else {
                Some(refreshed.as_str())
            };
            match request_api_room(http, &format!("{api}?{query}"), &referer, cookies, timeouts.api).await {
                Ok(room) => Ok(room),
                Err(error) if error.refresh_session => {
                    // 新会话重新生成签名；重签失败保留备用请求的原始错误。
                    request_api_room(http, &signed_api_url(&api, &query), &referer, cookies, timeouts.api)
                        .await
                        .map_err(|_| (error.message, refreshed.clone()))
                }
                Err(error) => Err((error.message, refreshed)),
            }
        }
        Err(error) => Err((error.message, cookies.unwrap_or_default().to_string())),
    }
}

fn parse_room_html(html: &str) -> Result<DouyinRoomData, String> {
    let chunks = Regex::new(
        r#"self\.__(?:next|pace)_f\.push\(\s*\[\s*\d+\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)"#,
    )
    .map_err(|e| e.to_string())?;
    let state_start = Regex::new(r#"\{\s*"state"\s*:"#).map_err(|e| e.to_string())?;
    for chunk in chunks.captures_iter(html) {
        let Ok(payload) = serde_json::from_str::<String>(&chunk[1]) else {
            continue;
        };
        let Some(start) = state_start.find(&payload).map(|matched| matched.start()) else {
            continue;
        };
        // 流式 JSON 解码读取完整对象，字符串内的括号和转义不截断对象。
        let Some(Ok(data)) = serde_json::Deserializer::from_str(&payload[start..])
            .into_iter::<Value>()
            .next()
        else {
            continue;
        };
        let Some(info) = data.pointer("/state/roomStore/roomInfo") else {
            continue;
        };
        let Some(mut room) = info.get("room").filter(|room| room.is_object()).cloned() else {
            continue;
        };
        if let Some(anchor) = info.get("anchor").filter(|anchor| anchor.is_object()) {
            room.as_object_mut()
                .unwrap()
                .insert("anchor".into(), anchor.clone());
        }
        crate::platforms::common::follow_metadata::preserve_douyin_partition(&mut room, info);
        if room_status(&room).is_ok() {
            return Ok(DouyinRoomData { room });
        }
    }
    Err("抖音网页未返回有效直播间数据，可能需要验证或页面结构已变化".into())
}

#[cfg(test)]
async fn fetch_room_by_web_rid(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
) -> Result<DouyinRoomData, String> {
    fetch_room_by_web_rid_inner(http, id, cookies, base, false, tokio::time::Instant::now() + ROOM_TIMEOUT).await
}

#[cfg(test)]
async fn fetch_room_by_web_rid_for_follow(http: &HttpClient, id: &str, cookies: Option<&str>, base: &str) -> Result<DouyinRoomData, String> {
    fetch_room_by_web_rid_inner(http, id, cookies, base, true, tokio::time::Instant::now() + FOLLOW_ROOM_TIMEOUT).await
}

async fn fetch_room_by_web_rid_inner(http: &HttpClient, id: &str, cookies: Option<&str>, base: &str, retain_category: bool, deadline: tokio::time::Instant) -> Result<DouyinRoomData, String> {
    let timeouts = if retain_category { FOLLOW_TIMEOUTS } else { PLAYBACK_TIMEOUTS };
    match fetch_room_from_api(http, id, cookies, base, timeouts).await {
        Ok(room) if room_status(&room.room)? == 2 => Ok(room),
        Ok(mut snapshot) => {
            // 状态仍按原规则由当前网页复核；关注分类不应随复核失败而丢失。
            // Optional verification must finish before the complete room-query deadline,
            // including time already spent resolving a temporary room ID or refreshing cookies.
            let budget = deadline.saturating_duration_since(tokio::time::Instant::now())
                .saturating_sub(Duration::from_millis(100)).min(Duration::from_secs(4));
            let verification = tokio::time::timeout(budget, fetch_room_from_html(http, id, cookies, base, timeouts))
                .await.unwrap_or_else(|_| Err("抖音网页状态复核超时".into()));
            match verification {
                Ok(mut current) => {
                    if retain_category {
                        crate::platforms::common::follow_metadata::preserve_douyin_partition(&mut current.room, &snapshot.room);
                    }
                    Ok(current)
                }
                Err(_) if retain_category => {
                    // 仅供关注元数据：不发布未经复核的 OFFLINE，不影响播放器原有错误路径。
                    snapshot.room.as_object_mut().unwrap().remove("status");
                    Ok(snapshot)
                }
                Err(_) => Ok(snapshot),
            }
        }
        Err((api_error, active_cookie)) => {
            let cookies = if active_cookie.is_empty() {
                cookies
            } else {
                Some(active_cookie.as_str())
            };
            fetch_room_from_html(http, id, cookies, base, timeouts).await.map_err(|_| api_error)
        }
    }
}

async fn fetch_room_from_html(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
    timeouts: RoomTimeouts,
) -> Result<DouyinRoomData, String> {
    let page = format!("{base}/{id}");
    let active = active_cookie(http, &page, cookies);
    let merged = refresh_web_cookie(http, &page, Some(&active), timeouts.cookie).await;
    let page_cookie = if merged.is_empty() { cookies } else { Some(merged.as_str()) };
    // 直接使用平台请求头，避免通用客户端的默认 UA 覆盖抖音浏览器 UA。
    let html = http.inner.get(&page)
        .headers(request_headers(&page, page_cookie)?)
        .timeout(timeouts.page)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;
    parse_room_html(&html)
}

/// 支持稳定 webRid、临时 roomId、直播页链接和链接中的明确房间参数。
pub fn normalize_douyin_live_id(input: &str) -> String {
    let input = input.trim();
    if input.is_empty() {
        return String::new();
    }
    if let Some(qpos) = input.find('?') {
        let params: Vec<(String, String)> =
            serde_urlencoded::from_str(input[qpos + 1..].split('#').next().unwrap_or(""))
                .unwrap_or_default();
        // 同时带两类 ID 的分享链接优先稳定的 webRid。
        for key in ["web_rid", "webRid", "webId", "room_id", "roomId"] {
            if let Some((_, value)) = params
                .iter()
                .find(|(name, value)| name == key && !value.is_empty())
            {
                return value.clone();
            }
        }
    }
    if let Some(pos) = input.find("douyin.com/") {
        let path = input[pos + "douyin.com/".len()..]
            .split(['?', '#'])
            .next()
            .unwrap_or("");
        if let Some(segment) = path.rsplit('/').find(|segment| !segment.is_empty()) {
            return segment.to_string();
        }
    }
    input
        .split(['?', '&', '#'])
        .next()
        .unwrap_or(input)
        .to_string()
}

fn value_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn room_web_rid(room: &Value) -> Option<String> {
    room.pointer("/owner/web_rid")
        .and_then(value_id)
        .or_else(|| room.pointer("/anchor/web_rid").and_then(value_id))
        .or_else(|| room.get("web_rid").and_then(value_id))
}

pub async fn fetch_room_data(
    http: &HttpClient,
    raw_id: &str,
    cookies: Option<&str>,
) -> Result<DouyinRoomData, String> {
    let id = normalize_douyin_live_id(raw_id);
    tokio::time::timeout(ROOM_TIMEOUT, fetch_room_by_id(
        http,
        &id,
        cookies,
        LIVE_BASE,
        "https://webcast.amemv.com/webcast/room/reflow/info/",
    )).await.map_err(|_| "抖音房间查询超时，请重试".to_string())?
}

/// 关注和播放复用查询；只在关注路径保留状态未确认时的分类元数据。
pub async fn fetch_follow_room_data(http: &HttpClient, raw_id: &str, cookies: Option<&str>) -> Result<DouyinRoomData, String> {
    let id = normalize_douyin_live_id(raw_id);
    tokio::time::timeout(FOLLOW_ROOM_TIMEOUT, fetch_room_by_id_inner(http, &id, cookies, LIVE_BASE,
        "https://webcast.amemv.com/webcast/room/reflow/info/", true))
        .await.map_err(|_| "抖音房间查询超时，请重试".to_string())?
}

async fn fetch_room_by_id(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    live_base: &str,
    reflow_api: &str,
) -> Result<DouyinRoomData, String> {
    fetch_room_by_id_inner(http, id, cookies, live_base, reflow_api, false).await
}

async fn fetch_room_by_id_inner(http: &HttpClient, id: &str, cookies: Option<&str>, live_base: &str, reflow_api: &str, retain_category: bool) -> Result<DouyinRoomData, String> {
    let deadline = tokio::time::Instant::now() + if retain_category { FOLLOW_ROOM_TIMEOUT } else { ROOM_TIMEOUT };
    if id.is_empty() {
        return Err("抖音房间 ID 不能为空".into());
    }
    if id.len() <= 16 {
        return fetch_room_by_web_rid_inner(http, id, cookies, live_base, retain_category, deadline).await;
    }
    // 临时 roomId 通过 reflow 查询，不能传给 web_rid 接口。
    let params = [
        ("type_id", "0"),
        ("live_id", "1"),
        ("room_id", id),
        ("sec_user_id", ""),
        ("version_code", "99.99.99"),
        ("app_id", "6383"),
    ];
    let query = serde_urlencoded::to_string(params).map_err(|e| e.to_string())?;
    let timeout = if retain_category { FOLLOW_TIMEOUTS.api } else { PLAYBACK_TIMEOUTS.api };
    let active = active_cookie(http, live_base, cookies);
    let json: Value = http.inner.get(format!("{reflow_api}?{query}"))
        .headers(request_headers(live_base, Some(&active))?)
        .timeout(timeout)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let room = json
        .pointer("/data/room")
        .filter(|room| room.is_object())
        .cloned()
        .ok_or_else(|| "抖音 reflow 接口未返回有效房间数据".to_string())?;
    if room_status(&room)? == 4 {
        if let Some(web_rid) = room_web_rid(&room) {
            return fetch_room_by_web_rid_inner(http, &web_rid, cookies, live_base, retain_category, deadline).await;
        }
    }
    Ok(DouyinRoomData { room })
}

fn quality_tag(key: &str, name: &str) -> &'static str {
    if name.contains("原画") || key.eq_ignore_ascii_case("origin") {
        return "OD";
    }
    if name.contains("蓝光") {
        return "BD";
    }
    if name.contains("超清") {
        return "UHD";
    }
    if name.contains("高清") {
        return "HD";
    }
    if name.contains("标清") {
        return "SD";
    }
    if name.contains("流畅") {
        return "LD";
    }
    match key.to_ascii_uppercase().as_str() {
        "ORIGIN" | "OD" => "OD",
        "FULL_HD1" | "BD" => "BD",
        "UHD" => "UHD",
        "HD1" | "HD" => "HD",
        "SD1" | "SD2" | "SD" => "SD",
        "LD" | "LD1" => "LD",
        _ => "",
    }
}

fn quality_rank(tag: &str) -> i64 {
    match tag {
        "OD" => 6,
        "BD" => 5,
        "UHD" => 4,
        "HD" => 3,
        "SD" => 2,
        "LD" => 1,
        _ => 0,
    }
}

fn append_stream(
    streams: &mut Vec<DouyinStream>,
    key: &str,
    name: &str,
    level: i64,
    format: &'static str,
    url: &Value,
) {
    let Some(url) = url
        .as_str()
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    else {
        return;
    };
    if streams
        .iter()
        .any(|stream| stream.url == url && stream.format == format && stream.key == key)
    {
        return;
    }
    streams.push(DouyinStream {
        key: key.into(),
        name: name.into(),
        level,
        url: url.into(),
        format,
    });
}

fn collect_douyin_streams(room: &Value) -> Vec<DouyinStream> {
    let mut streams = Vec::new();
    let Some(stream_url) = room.get("stream_url") else {
        return streams;
    };
    let mut pulls = Vec::new();
    if let Some(data) = stream_url.pointer("/live_core_sdk_data/pull_data") {
        pulls.push(data);
    }
    if let Some(data) = stream_url.get("pull_datas").and_then(Value::as_object) {
        pulls.extend(data.values());
    }
    for pull in pulls {
        let Some(data) = pull
            .get("stream_data")
            .and_then(Value::as_str)
            .and_then(|data| serde_json::from_str::<Value>(data).ok())
        else {
            continue;
        };
        let Some(data) = data.get("data").and_then(Value::as_object) else {
            continue;
        };
        if let Some(qualities) = pull
            .pointer("/options/qualities")
            .or_else(|| stream_url.pointer("/live_core_sdk_data/pull_data/options/qualities"))
            .and_then(Value::as_array)
        {
            for quality in qualities {
                let Some(key) = quality.get("sdk_key").and_then(Value::as_str) else {
                    continue;
                };
                let Some(main) = data.get(key).and_then(|stream| stream.get("main")) else {
                    continue;
                };
                let name = quality.get("name").and_then(Value::as_str).unwrap_or(key);
                let level = quality
                    .get("level")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                for format in ["flv", "hls"] {
                    if let Some(url) = main.get(format) {
                        append_stream(&mut streams, key, name, level, format, url);
                    }
                }
            }
        } else {
            for (key, stream) in data {
                for format in ["flv", "hls"] {
                    if let Some(url) = stream.pointer(&format!("/main/{format}")) {
                        append_stream(
                            &mut streams,
                            key,
                            key,
                            quality_rank(quality_tag(key, key)),
                            format,
                            url,
                        );
                    }
                }
            }
        }
    }
    for (map_name, format) in [("flv_pull_url", "flv"), ("hls_pull_url_map", "hls")] {
        if let Some(map) = stream_url.get(map_name).and_then(Value::as_object) {
            for (key, url) in map {
                let tag = quality_tag(key, key);
                if !streams.iter().any(|stream| {
                    stream.format == format
                        && (if tag.is_empty() {
                            stream.key == *key
                        } else {
                            quality_tag(&stream.key, &stream.name) == tag
                        })
                }) {
                    append_stream(&mut streams, key, key, quality_rank(tag), format, url);
                }
            }
        }
    }
    // 清晰度顺序来自接口 level，同一画质中 FLV 先于 HLS。
    streams.sort_by(|a, b| b.level.cmp(&a.level).then_with(|| a.format.cmp(b.format)));
    streams
}

/// 只返回实际选中的同一画质候选；主地址为第一项，保留 FLV/HLS 的原始 URL。
pub fn normalize_quality_tag(input: &str) -> &'static str {
    match input.trim().to_ascii_uppercase().as_str() {
        "BD" => "BD",
        "UHD" => "UHD",
        "HD" => "HD",
        "SD" => "SD",
        "LD" => "LD",
        _ => "OD",
    }
}

pub fn streams_for_quality(room: &Value, desired_quality: &str) -> Vec<DouyinStream> {
    let streams = collect_douyin_streams(room);
    let desired = normalize_quality_tag(desired_quality);
    let selected = streams
        .iter()
        .find(|stream| quality_tag(&stream.key, &stream.name) == desired)
        .or_else(|| streams.first());
    let Some(selected) = selected else {
        return Vec::new();
    };
    let tag = quality_tag(&selected.key, &selected.name);
    let key = selected.key.clone();
    let mut selected = streams
        .into_iter()
        .filter(|stream| {
            if tag.is_empty() {
                stream.key == key
            } else {
                quality_tag(&stream.key, &stream.name) == tag
            }
        })
        .collect::<Vec<_>>();
    selected.sort_by(|a, b| a.format.cmp(b.format));
    selected
}

pub fn choose_flv_stream(room: &Value, desired_quality: &str) -> Option<(String, String)> {
    streams_for_quality(room, desired_quality)
        .into_iter()
        .next()
        .map(|stream| (stream.key, stream.url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn 缺失或非法直播状态视为接口异常而非关播() {
        for room in [
            json!({}),
            json!({"status": "blocked"}),
            json!({"status": null}),
        ] {
            let body = json!({"data": {"data": [room]}}).to_string();
            let (base, server) = serve(vec![(200, "", body)]);
            let result = request_api_room(
                &HttpClient::new_direct_connection().unwrap(),
                &format!("{base}/api"),
                &base,
                None,
                PLAYBACK_TIMEOUTS.api,
            )
            .await;
            assert!(result.is_err());
            assert!(result.unwrap_err().refresh_session);
            assert_eq!(server.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn 网页缺失直播状态不能伪装为关播() {
        let state = json!({"state": {"roomStore": {"roomInfo": {"room": {"id_str": "123"}}}}});
        let page = format!(
            "<script>self.__next_f.push([1,{}])</script>",
            serde_json::to_string(&format!("7:{state}\n")).unwrap()
        );
        assert!(parse_room_html(&page).is_err());
    }

    #[test]
    fn 高清和标清标签选择各自流而非默认原画() {
        let room = json!({"stream_url": {"flv_pull_url": {
            "ORIGIN": "https://example.com/origin.flv",
            "HD1": "https://example.com/hd.flv",
            "SD1": "https://example.com/sd.flv"
        }}});
        assert_eq!(normalize_quality_tag(" hd "), "HD");
        assert_eq!(normalize_quality_tag("sd"), "SD");
        assert_eq!(normalize_quality_tag("LD"), "LD");
        assert_eq!(normalize_quality_tag("invalid"), "OD");
        assert_eq!(
            choose_flv_stream(&room, "HD"),
            Some(("HD1".into(), "https://example.com/hd.flv".into()))
        );
        assert_eq!(
            choose_flv_stream(&room, "SD"),
            Some(("SD1".into(), "https://example.com/sd.flv".into()))
        );
    }

    #[tokio::test]
    async fn 临时房间号通过重流接口查询且关播旧场次跟随稳定房间号() {
        for status in [2, 4] {
            let mut responses = vec![(200, "", json!({"data": {"room": {
                "id_str": "1234567890123456789", "status": status, "owner": {"web_rid": "654321"}
            }}}).to_string())];
            if status == 4 {
                responses.push((200, "", api_room(2)));
            }
            let (base, server) = serve(responses);
            let room = fetch_room_by_id(
                &HttpClient::new_direct_connection().unwrap(),
                "1234567890123456789",
                None,
                &base,
                &format!("{base}/webcast/room/reflow/info/"),
            )
            .await
            .unwrap()
            .room;
            assert_eq!(room["status"], 2);
            let requests = server.join().unwrap();
            assert!(requests[0].starts_with("GET /webcast/room/reflow/info/?"));
            assert!(requests[0].contains("room_id=1234567890123456789"));
            if status == 4 {
                assert_eq!(requests.len(), 2);
                assert!(requests[1].contains("web_rid=654321"));
            } else {
                assert_eq!(requests.len(), 1);
            }
        }
    }

    #[tokio::test]
    async fn 临时房间接口失败不把长房间号误当稳定房间号() {
        let (base, server) = serve(vec![(404, "", String::new())]);
        let error = fetch_room_by_id(
            &HttpClient::new_direct_connection().unwrap(),
            "1234567890123456789",
            None,
            &base,
            &format!("{base}/webcast/room/reflow/info/"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("404"));
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn 未知清晰度键不会丢弃其他未知流() {
        let room = json!({"stream_url": {"flv_pull_url": {
            "quality_a": "https://example.com/a.flv",
            "quality_b": "https://example.com/b.flv"
        }}});
        let streams = collect_douyin_streams(&room);
        assert_eq!(streams.len(), 2);
    }

    #[test]
    fn 主拉流数据缺少配置时复用已有清晰度定义() {
        let room = json!({"stream_url": {
            "live_core_sdk_data": {"pull_data": {"options": {"qualities": [
                {"name": "超清", "sdk_key": "hd", "level": 3},
                {"name": "蓝光", "sdk_key": "uhd", "level": 4}
            ]}}},
            "pull_datas": {"1": {"stream_data": json!({"data": {
                "hd": {"main": {"flv": "https://example.com/clear.flv"}},
                "uhd": {"main": {"flv": "https://example.com/blue.flv"}}
            }}).to_string()}}
        }});
        assert_eq!(
            choose_flv_stream(&room, "BD"),
            Some(("uhd".into(), "https://example.com/blue.flv".into()))
        );
        assert_eq!(
            choose_flv_stream(&room, "UHD"),
            Some(("hd".into(), "https://example.com/clear.flv".into()))
        );
    }

    #[tokio::test]
    async fn 网页回退继续保留接口更新后的访客会话() {
        let (base, server) = serve(vec![
            (444, "", String::new()),
            (200, "Set-Cookie: ttwid=fresh; Path=/\r\n", String::new()),
            (403, "", String::new()),
            (
                200,
                "Set-Cookie: __ac_nonce=nonce; Path=/\r\n",
                String::new(),
            ),
            (200, "", room_page("next")),
        ]);
        let room = fetch_room_by_web_rid(
            &HttpClient::new_direct_connection().unwrap(),
            "123456",
            Some("ttwid=expired; sessionid=account"),
            &base,
        )
        .await
        .unwrap()
        .room;
        assert_eq!(room["status"], 2);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 5);
        assert!(requests[4].contains("ttwid=fresh"));
        assert!(requests[4].contains("sessionid=account"));
        assert!(!requests[4].contains("ttwid=expired"));
        // 备用请求的 403 不会再触发签名重试。
        assert!(!requests[3].contains("/webcast/"));
    }

    fn room_page(channel: &str) -> String {
        let state = json!({"state": {"appStore": {}, "roomStore": {"roomInfo": {
            "room": {"id_str": "1234567890123456789", "status": 2, "title": "标题 } ] \" 直播",
                "owner": {"nickname": "测试主播", "web_rid": "123456"}},
            "anchor": {"nickname": "离线主播"}
        }}}});
        format!(
            "<script>self.__{channel}_f.push([1,{}])</script>",
            serde_json::to_string(&format!("7:{state}\n")).unwrap()
        )
    }

    #[test]
    fn 网页解码兼容next和pace且不截断标题() {
        for channel in ["next", "pace"] {
            let room = parse_room_html(&room_page(channel)).unwrap().room;
            assert_eq!(room["title"], "标题 } ] \" 直播");
            assert_eq!(room["anchor"]["nickname"], "离线主播");
        }
        assert!(parse_room_html("<html>captcha 验证页面</html>").is_err());
    }

    #[test]
    fn 分享链接优先稳定网页房间号并保留长房间号() {
        assert_eq!(
            normalize_douyin_live_id(
                "https://live.douyin.com/123456?room_id=1234567890123456789&web_rid=654321"
            ),
            "654321"
        );
        assert_eq!(
            normalize_douyin_live_id("https://www.douyin.com/follow/live/123456?x=y"),
            "123456"
        );
        assert_eq!(
            normalize_douyin_live_id("1234567890123456789"),
            "1234567890123456789"
        );
    }

    #[test]
    fn 会话合并保留账号并只接受访客字段() {
        let mut headers = HeaderMap::new();
        for cookie in [
            "ttwid=fresh; Path=/; HttpOnly",
            "__ac_nonce=nonce; Path=/",
            "other=ignored",
        ] {
            headers.append(SET_COOKIE, HeaderValue::from_str(cookie).unwrap());
        }
        assert_eq!(
            merge_cookies(Some("ttwid=expired; sessionid=account"), &headers),
            "__ac_nonce=nonce; sessionid=account; ttwid=fresh"
        );
        assert_eq!(
            merge_cookies(Some("ttwid=existing; sessionid=account"), &HeaderMap::new()),
            "sessionid=account; ttwid=existing"
        );
    }

    #[test]
    fn 备用候选只属于当前画质且允许只有分片流() {
        let room = json!({"stream_url": {"live_core_sdk_data": {"pull_data": {
            "options": {"qualities": [
                {"name": "蓝光", "sdk_key": "uhd", "level": 4},
                {"name": "超清", "sdk_key": "hd", "level": 3}
            ]},
            "stream_data": json!({"data": {
                "uhd": {"main": {"flv": "https://example.com/blue.flv", "hls": "https://example.com/blue.m3u8"}},
                "hd": {"main": {"hls": "https://example.com/clear.m3u8"}}
            }}).to_string()
        }}}});
        let streams = streams_for_quality(&room, "BD");
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].format, "flv");
        assert_eq!(streams[1].format, "hls");
        assert!(streams.iter().all(|stream| stream.key == "uhd"));
        assert_eq!(
            choose_flv_stream(&room, "UHD"),
            Some(("hd".into(), "https://example.com/clear.m3u8".into()))
        );
    }

    // 只替换外部 HTTP 服务，实际请求、签名、Cookie、JSON 和网页回退均由生产模块执行。
    fn serve(
        responses: Vec<(u16, &str, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        serve_with_initial_delay(responses, Duration::ZERO)
    }

    fn serve_with_initial_delay(
        responses: Vec<(u16, &str, String)>,
        initial_delay: Duration,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let responses = responses
            .into_iter()
            .map(|(code, headers, body)| (code, headers.to_string(), body))
            .collect::<Vec<_>>();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (code, extra, body) in responses {
                let start = Instant::now();
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            let accept_timeout = if initial_delay.is_zero() { 3 } else { 6 };
                            if start.elapsed() > Duration::from_secs(accept_timeout) {
                                return requests;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("测试 HTTP 服务失败：{error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let count = socket.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                let response = format!("HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
                if requests.len() == 1 && !initial_delay.is_zero() {
                    // 第一条接口挂起时，网页仍可独立响应，模拟实际服务。
                    std::thread::spawn(move || {
                        std::thread::sleep(initial_delay);
                        let _ = socket.write_all(response.as_bytes());
                    });
                } else {
                    socket.write_all(response.as_bytes()).unwrap();
                }
            }
            requests
        });
        (base, handle)
    }

    fn api_room(status: i64) -> String {
        json!({"status_code": 0, "data": {"user": {"nickname": "离线主播", "avatar_thumb": {"url_list": ["https://example.com/avatar"]}},
            "data": [{"id_str": "1234567890123456789", "status": status, "title": "测试直播"}]}}).to_string()
    }

    #[tokio::test]
    async fn 主接口挂起时及时回退网页而非等待45秒() {
        let (base, server) = serve_with_initial_delay(vec![
            (200, "", api_room(2)),
            (200, "", String::new()),
            (200, "", room_page("pace")),
        ], Duration::from_millis(3500));
        let start = std::time::Instant::now();
        let room = fetch_room_by_web_rid_for_follow(&HttpClient::new_direct_connection().unwrap(), "123456", None, &base)
            .await.unwrap().room;
        assert_eq!(room["status"], 2);
        assert!(start.elapsed() < Duration::from_secs(5));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("GET /123456 "));
    }

    #[tokio::test]
    async fn 接口旧关播状态必须由当前网页复核() {
        let (base, server) = serve(vec![
            (200, "", api_room(4)),
            (200, "", String::new()),
            (200, "", room_page("pace")),
        ]);
        let room = fetch_room_by_web_rid(&HttpClient::new_direct_connection().unwrap(), "123456", None, &base)
            .await.unwrap().room;
        assert_eq!(room["status"], 2);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].to_lowercase().contains(&format!("user-agent: {}", DEFAULT_USER_AGENT.to_lowercase())));
    }

    #[tokio::test]
    async fn 关注无法复核旧关播数据时不能确定未直播() {
        let (base, server) = serve(vec![
            (200, "", api_room(4)),
            (200, "", String::new()),
            (200, "", "<html>captcha</html>".into()),
        ]);
        let result = fetch_room_by_web_rid_for_follow(&HttpClient::new_direct_connection().unwrap(), "123456", None, &base).await.unwrap();
        assert!(result.room.get("status").is_none());
        assert_eq!(server.join().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn 当前网页也确认关播才返回关播状态() {
        let offline_page = room_page("pace").replace("\\\"status\\\":2", "\\\"status\\\":4");
        assert_eq!(parse_room_html(&offline_page).unwrap().room["status"], 4);
        let (base, server) = serve(vec![
            (200, "", api_room(4)), (200, "", String::new()), (200, "", offline_page),
        ]);
        let room = fetch_room_by_web_rid(
            &HttpClient::new_direct_connection().unwrap(),
            "123456",
            None,
            &base,
        )
        .await
        .unwrap()
        .room;
        assert_eq!(room["status"], 4);
        assert_eq!(room["anchor"]["nickname"], "离线主播");
        assert_eq!(server.join().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn 接口失败后读取网页并合并会话() {
        let (base, server) = serve(vec![
            (403, "", String::new()),
            (
                200,
                "Set-Cookie: __ac_nonce=nonce; Path=/\r\n",
                String::new(),
            ),
            (200, "", room_page("pace")),
        ]);
        let room = fetch_room_by_web_rid(
            &HttpClient::new_direct_connection().unwrap(),
            "123456",
            Some("ttwid=user; sessionid=account"),
            &base,
        )
        .await
        .unwrap()
        .room;
        assert_eq!(room["id_str"], "1234567890123456789");
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[1].starts_with("HEAD /123456 "));
        assert!(requests[2].starts_with("GET /123456 "));
        assert!(requests[2].contains("sessionid=account"));
        assert!(requests[2].contains("__ac_nonce=nonce"));
    }

    #[tokio::test]
    async fn 网页也失败时保留接口原始错误码() {
        let (base, server) = serve(vec![
            (503, "", String::new()),
            (200, "", String::new()),
            (200, "", "<html>captcha</html>".into()),
        ]);
        let error = fetch_room_by_web_rid(
            &HttpClient::new_direct_connection().unwrap(),
            "123456",
            None,
            &base,
        )
        .await
        .unwrap_err();
        assert!(error.contains("503"));
        assert_eq!(server.join().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn 空响应或444刷新会话后使用无签名备用请求() {
        for code in [200, 444] {
            let (base, server) = serve(vec![
                (code, "", String::new()),
                (
                    404,
                    "Set-Cookie: ttwid=fresh; Path=/; HttpOnly\r\n",
                    String::new(),
                ),
                (200, "", api_room(2)),
            ]);
            let room = fetch_room_by_web_rid(
                &HttpClient::new_direct_connection().unwrap(),
                "123456",
                Some("ttwid=expired; sessionid=account"),
                &base,
            )
            .await
            .unwrap()
            .room;
            assert_eq!(room["status"], 2);
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[0].contains("a_bogus="));
            assert!(requests[1].starts_with("HEAD / "));
            assert!(!requests[2].contains("a_bogus="));
            assert!(requests[2].contains("ttwid=fresh"));
            assert!(requests[2].contains("sessionid=account"));
            assert!(!requests[2].contains("ttwid=expired"));
        }
    }

    #[tokio::test]
    async fn 无签名备用仍拒绝时重新签名且成功后不读网页() {
        let (base, server) = serve(vec![
            (444, "", String::new()),
            (200, "Set-Cookie: ttwid=fresh; Path=/\r\n", String::new()),
            (444, "", String::new()),
            (200, "", api_room(2)),
        ]);
        let room = fetch_room_by_web_rid(
            &HttpClient::new_direct_connection().unwrap(),
            "123456",
            None,
            &base,
        )
        .await
        .unwrap()
        .room;
        assert_eq!(room["status"], 2);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(!requests[2].contains("a_bogus="));
        assert!(requests[3].contains("a_bogus="));
    }

    #[test]
    fn 清晰度按流键选择而非字典迭代位置() {
        let room = json!({"stream_url": {"flv_pull_url": {
            "FULL_HD1": "https://example.com/uhd.flv",
            "HD1": "https://example.com/hd.flv",
            "ORIGIN": "https://example.com/origin.flv",
            "SD1": "https://example.com/sd.flv"
        }}});
        assert_eq!(
            choose_flv_stream(&room, "OD"),
            Some(("ORIGIN".into(), "https://example.com/origin.flv".into()))
        );
        assert_eq!(
            choose_flv_stream(&room, "BD"),
            Some(("FULL_HD1".into(), "https://example.com/uhd.flv".into()))
        );
    }

    #[test]
    fn 读取实际sdk键对应的流且保留原始地址() {
        let room = json!({"stream_url": {"live_core_sdk_data": {"pull_data": {
            "options": {"qualities": [
                {"name": "原画", "sdk_key": "origin", "level": 5},
                {"name": "超清", "sdk_key": "uhd", "level": 4}
            ]},
            "stream_data": json!({"data": {
                "origin": {"main": {"flv": "http://example.com/origin.flv?sign=1", "hls": "https://example.com/origin.m3u8"}},
                "uhd": {"main": {"flv": "https://example.com/uhd.flv"}}
            }}).to_string()
        }}}});
        assert_eq!(
            choose_flv_stream(&room, "OD"),
            Some((
                "origin".into(),
                "http://example.com/origin.flv?sign=1".into()
            ))
        );
        assert_eq!(
            choose_flv_stream(&room, "UHD"),
            Some(("uhd".into(), "https://example.com/uhd.flv".into()))
        );
    }

    fn parity_path(deep: bool) -> Value {
        let mut path = json!({"partition":{"id_str":"103","type":4,"title":"游戏"},
            "sub_partition":{"partition":{"id_str":"1","type":1,"title":"射击游戏"}}});
        if deep {
            path["sub_partition"]["sub_partition"] = json!({"partition":{"id_str":"1010032","type":1,"title":"和平精英"}});
        }
        path
    }

    #[tokio::test]
    async fn parity_api_preserves_sibling_partition_for_live_and_offline_without_extra_requests() {
        for status in [2,4] {
            let body = json!({"data":{"data":[{"status":status,"partition_road_map":parity_path(false)}],
                "partition_road_map":parity_path(true)}}).to_string();
            let (base, server) = serve(vec![(200,"",body)]);
            let data = request_api_room(&HttpClient::new_direct_connection().unwrap(),
                &format!("{base}/api"),&base,None,PLAYBACK_TIMEOUTS.api).await.unwrap();
            let metadata = crate::platforms::common::follow_metadata::douyin_metadata(&data.room,None);
            assert_eq!(metadata.category_name.as_deref(),Some("和平精英"));
            assert_eq!(metadata.category_id.as_deref(),Some("1010032,1"));
            assert_eq!(data.room["status"],status);
            assert_eq!(server.join().unwrap().len(),1);
        }
    }

    #[test]
    fn parity_html_keeps_deeper_of_room_and_room_info_partition_for_both_statuses() {
        for status in [2,4] {
            for room_deeper in [false,true] {
                let state = json!({"state":{"roomStore":{"roomInfo":{
                    "room":{"status":status,"partition_road_map":parity_path(room_deeper)},
                    "anchor":{"nickname":"不从此处猜分类"},
                    "partition_road_map":parity_path(!room_deeper)
                }}}});
                let page = format!("<script>self.__pace_f.push([1,{}])</script>",
                    serde_json::to_string(&format!("7:{state}\n")).unwrap());
                let data = parse_room_html(&page).unwrap();
                let metadata = crate::platforms::common::follow_metadata::douyin_metadata(&data.room,None);
                assert_eq!(metadata.category_name.as_deref(),Some("和平精英"));
                assert_eq!(metadata.category_id.as_deref(),Some("1010032,1"));
                assert_eq!(data.room["status"],status);
                assert_eq!(data.room["anchor"]["nickname"],"不从此处猜分类");
            }
        }
    }

    #[tokio::test]
    async fn parity_offline_id_only_sibling_path_resolves_official_directory() {
        let mut path = parity_path(true);
        path["sub_partition"]["sub_partition"]["partition"].as_object_mut().unwrap().remove("title");
        let state = json!({"state":{"roomStore":{"roomInfo":{"room":{"status":4},"partition_road_map":path}}}});
        let page = format!("<script>self.__next_f.push([1,{}])</script>",
            serde_json::to_string(&format!("7:{state}\n")).unwrap());
        let data = parse_room_html(&page).unwrap();
        let cache = crate::platforms::common::follow_metadata::DirectoryCache::default();
        let result = crate::platforms::douyin::follow_category::metadata_with_directory(&data.room,&cache,||async {
            Ok(std::collections::HashMap::from([("1010032,1".into(),"和平精英".into())]))
        }).await;
        assert_eq!(result.category_name.as_deref(),Some("和平精英"));
        assert_eq!(result.category_id.as_deref(),Some("1010032,1"));
        assert_eq!(data.room["status"],4);
    }

    #[tokio::test]
    async fn follow_category_survives_html_status_verification_failure_without_false_offline() {
        let body = json!({"data":{"data":[{"status":4}],"partition_road_map":parity_path(true)}}).to_string();
        let (base, server) = serve(vec![(200,"",body),(444,"","".into()),(444,"","".into())]);
        let result = fetch_room_by_web_rid_for_follow(&HttpClient::new_direct_connection().unwrap(),"123",None,&base).await.unwrap();
        let metadata = crate::platforms::common::follow_metadata::douyin_metadata(&result.room,None);
        assert_eq!(metadata.category_name.as_deref(),Some("和平精英"));
        assert!(result.room.get("status").is_none_or(Value::is_null));
        assert_eq!(server.join().unwrap().len(),3);
    }

    #[tokio::test]
    async fn follow_category_retains_api_path_when_verified_html_omits_it() {
        let api = json!({"data":{"data":[{"status":4}],"partition_road_map":parity_path(true)}}).to_string();
        let state = json!({"state":{"roomStore":{"roomInfo":{"room":{"status":4}}}}});
        let page = format!("<script>self.__next_f.push([1,{}])</script>",serde_json::to_string(&format!("7:{state}\n")).unwrap());
        let (base, server) = serve(vec![(200,"",api),(200,"",page.clone()),(200,"",page)]);
        let result = fetch_room_by_web_rid_for_follow(&HttpClient::new_direct_connection().unwrap(),"123",None,&base).await.unwrap();
        assert_eq!(result.room["status"],4);
        assert_eq!(crate::platforms::common::follow_metadata::douyin_metadata(&result.room,None).category_name.as_deref(),Some("和平精英"));
        assert_eq!(server.join().unwrap().len(),3);
    }
    #[test]
    fn first_playback_request_uses_simple_live_visitor_cookie_and_random_ms_token() {
        let headers = request_headers("https://live.douyin.com/123", None).unwrap();
        assert!(headers.get(COOKIE).and_then(|v|v.to_str().ok()).unwrap_or("").contains("ttwid="));
        let first = signed_api_url("https://live.douyin.com/webcast/room/web/enter/", "aid=6383&web_rid=123");
        let next = signed_api_url("https://live.douyin.com/webcast/room/web/enter/", "aid=6383&web_rid=123");
        let params = |url:&str| url::Url::parse(url).unwrap().query_pairs().into_owned().collect::<std::collections::HashMap<_,_>>();
        let a=params(&first);let b=params(&next);
        assert_eq!(a.get("msToken").map(String::len),Some(107));
        assert_ne!(a["msToken"],b["msToken"]);
        assert!(a["msToken"].bytes().all(|b|b.is_ascii_alphanumeric()));
        assert!(a["a_bogus"].ends_with('='));
    }

    #[tokio::test]
    async fn playback_accepts_api_response_slower_than_follow_refresh_deadline() {
        let (base,server)=serve_with_initial_delay(vec![(200,"",api_room(2))],Duration::from_millis(3500));
        let data=fetch_room_by_web_rid(&HttpClient::new_direct_connection().unwrap(),"123456",None,&base).await;
        assert!(data.is_ok(),"播放查询不能沿用关注的3秒期限：{data:?}");
        assert_eq!(server.join().unwrap().len(),1,"健康但稍慢的接口不能引发额外网页请求");
    }

    #[tokio::test]
    async fn refreshed_visitor_session_is_reused_by_next_room_request() {
        let (base,server)=serve(vec![
            (444,"",String::new()),
            (200,"Set-Cookie: ttwid=fresh; Path=/\r\n",String::new()),
            (200,"",api_room(2)),(200,"",api_room(2)),
        ]);
        let http=HttpClient::new_direct_connection().unwrap();
        fetch_room_by_web_rid(&http,"123456",None,&base).await.unwrap();
        fetch_room_by_web_rid(&http,"654321",None,&base).await.unwrap();
        let requests=server.join().unwrap();assert_eq!(requests.len(),4);
        assert!(requests[3].contains("ttwid=fresh"),"新房间应复用刷新成功的访客会话");
    }

    #[tokio::test]
    async fn playback_keeps_confirmed_offline_when_optional_html_is_unavailable() {
        let (base,server)=serve(vec![(200,"",api_room(4)),(200,"",String::new()),(444,"",String::new())]);
        let data=fetch_room_by_web_rid(&HttpClient::new_direct_connection().unwrap(),"123456",None,&base).await;
        assert!(data.is_ok(),"不能把已经确认下播的房间改成网络失败：{data:?}");assert_eq!(data.unwrap().room["status"],4);
        assert_eq!(server.join().unwrap().len(),3);
    }

    #[tokio::test]
    async fn confirmed_offline_survives_hanging_optional_head_and_get() {
        use std::io::{Read,Write};
        for slow_get in [false,true] {
            let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
            let api=api_room(4);
            let server=std::thread::spawn(move|| {
                let count=if slow_get {3}else{2};
                for index in 0..count {
                    let (mut socket,_)=listener.accept().unwrap();let mut buffer=[0;4096];let _=socket.read(&mut buffer);
                    if index==count-1 {std::thread::sleep(Duration::from_secs(5));}
                    let body=if index==0 {api.as_str()}else{""};
                    let response=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                    let _=socket.write_all(response.as_bytes());
                }
            });
            let result=tokio::time::timeout(Duration::from_millis(4500),fetch_room_by_web_rid(&HttpClient::new_direct_connection().unwrap(),"123456",None,&base)).await;
            assert!(result.is_ok(),"可选网页校验不能吞掉已确认下播的API快照，slow_get={slow_get}");
            assert_eq!(result.unwrap().unwrap().room["status"],4);server.join().unwrap();
        }
    }

}
