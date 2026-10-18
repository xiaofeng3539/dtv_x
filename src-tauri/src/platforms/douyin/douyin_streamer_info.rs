use crate::platforms::common::http_client::HttpClient;
use crate::platforms::common::{FollowHttpClient, GetStreamUrlPayload, LiveStreamInfo};
use crate::platforms::douyin::web_api::{fetch_follow_room_data, normalize_douyin_live_id, DouyinRoomData};
use std::sync::OnceLock;
use tauri::command;
use tauri::State;

// 抖音分类目录缓存：整个应用共享一个；失败/空目录不缓存，允许下次重试。
static DIRECTORY_CACHE: OnceLock<crate::platforms::douyin::follow_category::DirectoryCache> =
    OnceLock::new();

#[command]
pub async fn fetch_douyin_streamer_info(
    payload: GetStreamUrlPayload,
    follow_http: State<'_, FollowHttpClient>,
) -> Result<LiveStreamInfo, String> {
    let requested_id = payload.args.room_id_str.trim().to_string();
    if requested_id.is_empty() {
        return Ok(LiveStreamInfo {
            title: None,
            anchor_name: None,
            avatar: None,
            stream_url: None,
            status: None,
            error_message: Some("Douyin web_id cannot be empty.".to_string()),
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
            category_name: None,
            category_id: None,
            popularity: None,
        });
    }

    let http_client: &HttpClient = &follow_http.0;

    let normalized_id = normalize_douyin_live_id(&requested_id);

    match fetch_follow_room_data(http_client, &normalized_id, None).await {
        Ok(DouyinRoomData { room }) => {
            let web_rid = super::douyin_streamer_detail::extract_web_rid(&room)
                .unwrap_or_else(|| normalized_id.clone());
            let status = room
                .get("status")
                .and_then(|v| v.as_i64())
                .unwrap_or_default() as i32;
            let title = room
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let anchor_name = super::douyin_streamer_detail::extract_anchor_name(&room);
            let avatar = super::douyin_streamer_detail::extract_avatar(&room);
            let available_streams = super::douyin_streamer_detail::collect_available_streams(&room);

            // 分类取官方分区路径最深一级；只有 ID 时共享补查分类目录（不额外解析播放）。
            let cache = DIRECTORY_CACHE.get_or_init(Default::default);
            let directory_client = follow_http.0.inner.clone();
            let metadata =
                super::follow_category::metadata_with_directory(&room, cache, move || {
                    super::follow_category::fetch_douyin_directory_page(directory_client)
                })
                .await;

            Ok(LiveStreamInfo {
                title,
                anchor_name,
                avatar,
                stream_url: None,
                status: Some(status),
                error_message: None,
                upstream_url: None,
                available_streams,
                normalized_room_id: None,
                web_rid: Some(web_rid),
                category_name: metadata.category_name,
                category_id: metadata.category_id,
                popularity: metadata.popularity,
            })
        }
        Err(e) => Ok(LiveStreamInfo {
            title: None,
            anchor_name: None,
            avatar: None,
            stream_url: None,
            status: None,
                error_message: Some(format!("获取抖音房间信息失败: {}", e)),
                upstream_url: None,
                available_streams: None,
                normalized_room_id: None,
                web_rid: Some(normalized_id),
                category_name: None,
                category_id: None,
                popularity: None,
        }),
    }
}
