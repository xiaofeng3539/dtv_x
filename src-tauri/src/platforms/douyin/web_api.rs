// 房间加载和 sdk_key 流映射参考移植自 dart_simple_live/simple_live_core/lib/src/douyin_site.dart。
// 参考项目采用 GPL-3.0；分发包含派生实现的版本时须履行 GPL 的许可及对应源码提供要求。
use crate::platforms::common::http_client::HttpClient;
use crate::platforms::douyin::a_bogus::generate_a_bogus;
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, REFERER, SET_COOKIE, USER_AGENT,
};
use serde_json::Value;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400";
const LIVE_BASE: &str = "https://live.douyin.com";

#[derive(Debug, Clone)]
pub struct DouyinRoomData {
    pub room: Value,
}

pub fn room_status(room: &Value) -> Result<i32, String> {
    room.get("status")
        .and_then(Value::as_i64)
        .filter(|status| *status >= 0)
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
    // 无账号 Cookie 时使用 HttpClient 的访客 Cookie Jar，不复用写死的过期 ttwid。
    if let Some(cookie) = cookies.filter(|cookie| !cookie.trim().is_empty()) {
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

async fn refresh_web_cookie(http: &HttpClient, page: &str, cookies: Option<&str>) -> String {
    match request_headers(page, cookies) {
        Ok(headers) => match http.inner.head(page).headers(headers).send().await {
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
) -> Result<DouyinRoomData, RoomApiError> {
    let headers = request_headers(referer, cookies).map_err(|message| RoomApiError {
        message,
        refresh_session: false,
    })?;
    let response = http
        .inner
        .get(api)
        .headers(headers)
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
        refresh_session: true,
    })?;
    if let Some(user) = json.pointer("/data/user").filter(|user| user.is_object()) {
        let object = room.as_object_mut().unwrap();
        if object.get("owner").map_or(true, |owner| !owner.is_object()) {
            object.insert("anchor".into(), user.clone());
        }
    }
    Ok(DouyinRoomData { room })
}

fn signed_api_url(api: &str, query: &str) -> String {
    format!(
        "{api}?{query}&a_bogus={}",
        generate_a_bogus(query, DEFAULT_USER_AGENT)
    )
}

async fn fetch_room_from_api(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
) -> Result<DouyinRoomData, (String, String)> {
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
        ("msToken", ""),
    ];
    let query = serde_urlencoded::to_string(params)
        .map_err(|e| (e.to_string(), cookies.unwrap_or_default().to_string()))?;
    match request_api_room(http, &signed_api_url(&api, &query), &referer, cookies).await {
        Ok(room) => Ok(room),
        Err(error) if error.refresh_session => {
            let refreshed = refresh_web_cookie(http, &format!("{base}/"), cookies).await;
            let cookies = if refreshed.is_empty() {
                cookies
            } else {
                Some(refreshed.as_str())
            };
            match request_api_room(http, &format!("{api}?{query}"), &referer, cookies).await {
                Ok(room) => Ok(room),
                Err(error) if error.refresh_session => {
                    // 新会话重新生成签名；重签失败保留备用请求的原始错误。
                    request_api_room(http, &signed_api_url(&api, &query), &referer, cookies)
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
        if room_status(&room).is_ok() {
            return Ok(DouyinRoomData { room });
        }
    }
    Err("抖音网页未返回有效直播间数据，可能需要验证或页面结构已变化".into())
}

async fn fetch_room_by_web_rid(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    base: &str,
) -> Result<DouyinRoomData, String> {
    match fetch_room_from_api(http, id, cookies, base).await {
        Ok(room) => Ok(room),
        Err((api_error, active_cookie)) => {
            let page = format!("{base}/{id}");
            let cookies = if active_cookie.is_empty() {
                cookies
            } else {
                Some(active_cookie.as_str())
            };
            let merged = refresh_web_cookie(http, &page, cookies).await;
            let page_cookie = if merged.is_empty() {
                cookies
            } else {
                Some(merged.as_str())
            };
            let fallback = async {
                let html = http
                    .get_text_with_headers(&page, Some(request_headers(&page, page_cookie)?))
                    .await?;
                parse_room_html(&html)
            }
            .await;
            // 回退失败保留接口原始错误；正常关播数据不会进入回退。
            fallback.map_err(|_| api_error)
        }
    }
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
    fetch_room_by_id(
        http,
        &id,
        cookies,
        LIVE_BASE,
        "https://webcast.amemv.com/webcast/room/reflow/info/",
    )
    .await
}

async fn fetch_room_by_id(
    http: &HttpClient,
    id: &str,
    cookies: Option<&str>,
    live_base: &str,
    reflow_api: &str,
) -> Result<DouyinRoomData, String> {
    if id.is_empty() {
        return Err("抖音房间 ID 不能为空".into());
    }
    if id.len() <= 16 {
        return fetch_room_by_web_rid(http, id, cookies, live_base).await;
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
    let json: Value = http
        .get_json_with_headers(
            &format!("{reflow_api}?{query}"),
            Some(request_headers(live_base, cookies)?),
        )
        .await?;
    let room = json
        .pointer("/data/room")
        .filter(|room| room.is_object())
        .cloned()
        .ok_or_else(|| "抖音 reflow 接口未返回有效房间数据".to_string())?;
    if room_status(&room)? == 4 {
        if let Some(web_rid) = room_web_rid(&room) {
            return fetch_room_by_web_rid(http, &web_rid, cookies, live_base).await;
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
                            if start.elapsed() > Duration::from_secs(3) {
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
                socket.write_all(response.as_bytes()).unwrap();
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
    async fn 关播房间只请求一次且保留主播元数据() {
        let (base, server) = serve(vec![(200, "", api_room(4))]);
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
        assert_eq!(server.join().unwrap().len(), 1);
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
}
