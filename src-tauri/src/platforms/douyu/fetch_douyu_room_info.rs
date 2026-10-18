// Douyu specific API logic will go here
// NOTE: This module already uses reqwest and is consistent with the unified Douyu HTTP client approach.

use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::State;

use crate::platforms::common::follow_metadata::{
    douyu_metadata, douyu_needs_directory, parse_douyu_directory, DirectoryCache,
};
use crate::platforms::common::FollowHttpClient;

// 斗鱼分类目录缓存：整个应用共享一个；失败/空目录不缓存，允许下次重试。
// betard 房间响应常只有分类 ID（second_lvl_name 缺失），用官方 cate/list 补名称。
static DOUYU_DIRECTORY_CACHE: OnceLock<DirectoryCache> = OnceLock::new();

// Define the structure to be returned to TypeScript
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct DouyuFollowInfo {
    room_id: String,
    room_name: Option<String>,
    nickname: Option<String>,
    avatar_url: Option<String>,
    video_loop: Option<i64>,
    show_status: Option<i64>,
    // 关注分类（游戏/分区分组）：来自 betard 同一响应，二级分类优先
    category_name: Option<String>,
    category_id: Option<String>,
    popularity: Option<f64>,
}

#[tauri::command]
pub async fn fetch_douyu_room_info(
    room_id: String,
    follow_http: State<'_, FollowHttpClient>,
) -> Result<DouyuFollowInfo, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Accept",
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(
        "Accept-Language",
        HeaderValue::from_static("zh-CN,zh;q=0.9"),
    );
    headers.insert("Cache-Control", HeaderValue::from_static("no-cache"));
    headers.insert("Pragma", HeaderValue::from_static("no-cache"));
    // room_id 来自前端 invoke，属于用户可控输入：若含非 ASCII 字符或换行，
    // HeaderValue::from_str 会返回 Err，原来的 unwrap() 直接 panic。
    // 这里用 ? 把它变成一条可读的普通错误，而不是让 IPC 任务以不可解释的方式失败。
    let referer = format!("https://www.douyu.com/{}", room_id);
    let referer_value = HeaderValue::from_str(&referer)
        .map_err(|_| format!("房间号非法（不能含非 ASCII 字符或换行）：{}", room_id))?;
    headers.insert("Referer", referer_value);
    headers.insert("User-Agent", HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"));

    let response_result = follow_http
        .0
        .inner
        .get(format!("https://www.douyu.com/betard/{}", room_id))
        .headers(headers)
        .send()
        .await;

    let response = match response_result {
        Ok(res) => res,
        Err(e) => {
            return Err(format!(
                "Network request failed for room {}: {}",
                room_id,
                e.to_string()
            ))
        }
    };

    if !response.status().is_success() {
        return Err(format!(
            "API request for room {} failed with status: {}",
            room_id,
            response.status()
        ));
    }

    let full_json_value = match response.json::<Value>().await {
        Ok(val) => val,
        Err(e) => {
            return Err(format!(
                "Failed to parse JSON for room {}: {}. Ensure API returns valid JSON.",
                room_id,
                e.to_string()
            ))
        }
    };
    let room_data_ref = full_json_value
        .get("data")
        .and_then(|d| d.get("room")) // Path 1: { data: { room: { ... } } }
        .or_else(|| full_json_value.get("data")) // Path 2: { data: { ...room_info... } }
        .or_else(|| full_json_value.get("room")) // Path 3: { room: { ... } }
        .or_else(|| Some(&full_json_value)); // Path 4: { ...room_info... } (root is room object)

    let room_data = match room_data_ref {
        Some(data) => data,
        None => {
            return Err(format!(
                "Could not locate room data block in JSON response for room {}",
                room_id
            ))
        }
    };

    let get_str = |val: &Value, key: &str| val.get(key).and_then(|v| v.as_str()).map(String::from);
    let get_i64 = |val: &Value, key: &str| val.get(key).and_then(|v| v.as_i64());
    let get_nested_str = |val: &Value, path: &[&str]| {
        let mut current = val;
        for key_part in path.iter() {
            current = current.get(key_part)?;
        }
        current.as_str().map(String::from)
    };

    // Prioritize avatar_mid if it exists at the room_data level, then try avatar.middle
    let avatar_final_url = get_str(room_data, "avatar_mid")
        .or_else(|| get_nested_str(room_data, &["avatar", "middle"]));

    // If API provides its own room_id, prefer that. Otherwise, use the input room_id.
    let final_room_id = get_str(room_data, "room_id").unwrap_or_else(|| room_id.clone());

    // 分类只来自本响应：second_lvl_name（具体游戏）优先，名称缺失时用官方目录按 ID 补齐；
    // 热度取 room_biz_all.hot。目录补查失败不影响直播状态。
    let metadata = {
        let cache = DOUYU_DIRECTORY_CACHE.get_or_init(Default::default);
        let directory = if douyu_needs_directory(room_data) {
            let client = follow_http.0.inner.clone();
            cache
                .get_or_fetch(move || fetch_douyu_directory(client))
                .await
        } else {
            None
        };
        douyu_metadata(room_data, directory.as_deref())
    };

    let info = DouyuFollowInfo {
        room_id: final_room_id,
        room_name: get_str(room_data, "room_name"),
        nickname: get_str(room_data, "nickname"),
        avatar_url: avatar_final_url,
        video_loop: get_i64(room_data, "videoLoop"),
        show_status: get_i64(room_data, "show_status"),
        category_name: metadata.category_name,
        category_id: metadata.category_id,
        popularity: metadata.popularity,
    };

    Ok(info)
}

/// 抓取斗鱼官方分类目录（m.douyu.com/api/cate/list，与 dart_simple_live getCategores 同源）：
/// cate2Info（510 个具体游戏）+ cate1Info（一级大类）。手机端 UA 即可匿名访问。
async fn fetch_douyu_directory(client: reqwest::Client) -> Result<std::collections::HashMap<String, String>, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "User-Agent",
        HeaderValue::from_static("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"),
    );
    let response = client
        .get("https://m.douyu.com/api/cate/list")
        .headers(headers)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("斗鱼分类目录请求失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("斗鱼分类目录返回 HTTP {status}"));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("斗鱼分类目录读取失败: {e}"))?;
    parse_douyu_directory(&body)
}

#[cfg(test)]
mod verify_tests {
    use super::*;

    /// 真实网络验证（手动跑：cargo test verify_real_douyu -- --ignored --nocapture）：
    /// 用真实 betard 房间 + 官方分类目录，端到端确认分类识别链路。
    #[tokio::test]
    #[ignore = "真实网络请求，仅在需要时手动运行"]
    async fn verify_real_douyu_category_chain() {
        let client = reqwest::Client::new();
        let mut headers = HeaderMap::new();
        headers.insert("User-Agent", HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"));
        headers.insert("Referer", HeaderValue::from_static("https://www.douyu.com/9999"));
        let body = client
            .get("https://www.douyu.com/betard/9999")
            .headers(headers)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let value: Value = serde_json::from_str(&body).unwrap();
        let room = value.get("room").unwrap();
        println!("[验证] betard/9999 second_lvl_name = {:?}", room.get("second_lvl_name"));

        let needs = douyu_needs_directory(room);
        println!("[验证] 需要目录补查: {needs}");
        let directory = if needs {
            fetch_douyu_directory(client.clone()).await.ok()
        } else {
            None
        };
        let metadata = douyu_metadata(room, directory.as_ref());
        println!("[验证] 9999 → name={:?} id={:?} popularity={:?}", metadata.category_name, metadata.category_id, metadata.popularity);
        assert!(metadata.category_name.is_some(), "斗鱼真实房间必须识别出分类，不能归入其他");
        assert!(metadata.popularity.is_some(), "热度应取自 room_biz_all.hot");

        // 场景 2：second_lvl_name 缺失、只有分类 ID 的房间，走官方目录补齐。
        let mut id_only = value.clone();
        id_only["room"]["second_lvl_name"] = serde_json::Value::Null;
        let room2 = id_only.get("room").unwrap();
        assert!(douyu_needs_directory(room2), "只有 ID 的房间应触发目录补查");
        let directory = fetch_douyu_directory(client).await.unwrap();
        let metadata2 = douyu_metadata(room2, Some(&directory));
        println!("[验证] 9999(仅ID) → name={:?} id={:?}", metadata2.category_name, metadata2.category_id);
        assert_eq!(metadata2.category_name.as_deref(), Some("DOTA2"), "目录必须按 cate2_id 映射回具体游戏");
    }
}
