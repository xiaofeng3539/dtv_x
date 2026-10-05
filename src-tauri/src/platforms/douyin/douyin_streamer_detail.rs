// 与 web_api.rs 共用参考 simple_live_core/lib/src/douyin_site.dart（GPL-3.0）的画质候选。
use crate::platforms::common::http_client::HttpClient;
use crate::platforms::common::types::StreamVariant;
use crate::platforms::common::GetStreamUrlPayload;
use crate::platforms::common::LiveStreamInfo as CommonLiveStreamInfo;
use crate::platforms::douyin::web_api::{
    fetch_room_data, normalize_douyin_live_id, normalize_quality_tag, room_status,
    streams_for_quality, DouyinRoomData,
};
use crate::proxy::ProxyServerHandle;
use crate::StreamUrlStore;
use serde_json::Value;
use tauri::{command, AppHandle, State};

const QUALITY_OD: &str = "OD";
#[command]
pub async fn get_douyin_live_stream_url(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: GetStreamUrlPayload,
) -> Result<CommonLiveStreamInfo, String> {
    get_douyin_live_stream_url_with_quality(
        app_handle,
        stream_url_store,
        proxy_server_handle,
        payload,
        QUALITY_OD.to_string(),
    )
    .await
}

#[command]
pub async fn get_douyin_live_stream_url_with_quality(
    _app_handle: AppHandle,
    _stream_url_store: State<'_, StreamUrlStore>,
    _proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: GetStreamUrlPayload,
    quality: String,
) -> Result<CommonLiveStreamInfo, String> {
    let requested_id = payload.args.room_id_str.trim().to_string();
    if requested_id.is_empty() {
        return Ok(CommonLiveStreamInfo {
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
        });
    }

    println!(
        "[Douyin Stream Detail] Fetching stream for '{}' with requested quality '{}'",
        requested_id, quality
    );

    let http_client = HttpClient::new_direct_connection()
        .map_err(|e| format!("Failed to create direct connection HttpClient: {}", e))?;

    let normalized_id = normalize_douyin_live_id(&requested_id);
    let DouyinRoomData { room } = fetch_room_data(&http_client, &normalized_id, None).await?;
    let room_id_str = room
        .get("id_str")
        .and_then(id_string)
        .or_else(|| room.get("id").and_then(id_string))
        .unwrap_or_else(|| normalized_id.clone());
    let web_rid = extract_web_rid(&room).unwrap_or_else(|| normalized_id.clone());
    let status = room_status(&room)?;
    let title = room
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let anchor_name = extract_anchor_name(&room);
    let avatar = extract_avatar(&room);
    let selected_streams = streams_for_quality(&room, normalize_quality_tag(&quality));
    let available_streams = stream_variants(&selected_streams);

    if status != 2 {
        println!(
            "[Douyin Stream Detail] Room '{}' is not live (status={}). Returning metadata only.",
            web_rid, status
        );
        return Ok(CommonLiveStreamInfo {
            title,
            anchor_name,
            avatar,
            stream_url: None,
            status: Some(status),
            error_message: None,
            upstream_url: None,
            available_streams: available_streams.clone(),
            normalized_room_id: Some(room_id_str),
            web_rid: Some(web_rid),
        });
    }

    let selected = selected_streams
        .first()
        .ok_or_else(|| "抖音直播间没有可用的 FLV/HLS 播放地址".to_string())?;
    println!(
        "[Douyin Stream Detail] Selected stream key='{}' format='{}'",
        selected.key, selected.format
    );
    // 使用接口返回的原始地址，避免改写协议破坏签名或不支持 HTTPS 的节点。
    let real_url = selected.url.clone();

    Ok(CommonLiveStreamInfo {
        title,
        anchor_name,
        avatar,
        stream_url: Some(real_url.clone()),
        status: Some(status),
        error_message: None,
        upstream_url: Some(real_url),
        available_streams,
        normalized_room_id: Some(room_id_str),
        web_rid: Some(web_rid),
    })
}

pub(crate) fn extract_web_rid(room: &Value) -> Option<String> {
    room.pointer("/owner/web_rid")
        .and_then(id_string)
        .or_else(|| room.pointer("/anchor/web_rid").and_then(id_string))
        .or_else(|| room.get("web_rid").and_then(id_string))
}

fn id_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

pub(crate) fn extract_anchor_name(room: &Value) -> Option<String> {
    room.get("anchor_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            room.get("owner")
                .and_then(|o| o.get("nickname"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            room.get("anchor")
                .and_then(|a| a.get("nickname"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub(crate) fn extract_avatar(room: &Value) -> Option<String> {
    room.get("owner")
        .and_then(|o| o.get("avatar_thumb"))
        .and_then(|thumb| thumb.get("url_list"))
        .and_then(|list| list.get(0))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            room.get("anchor")
                .and_then(|a| a.get("avatar_thumb"))
                .and_then(|thumb| thumb.get("url_list"))
                .and_then(|list| list.get(0))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub(crate) fn collect_available_streams(room: &Value) -> Option<Vec<StreamVariant>> {
    stream_variants(&streams_for_quality(room, QUALITY_OD))
}

fn stream_variants(streams: &[super::web_api::DouyinStream]) -> Option<Vec<StreamVariant>> {
    if streams.is_empty() {
        return None;
    }
    Some(
        streams
            .iter()
            .map(|stream| StreamVariant {
                url: stream.url.clone(),
                format: Some(stream.format.to_string()),
                desc: Some(stream.name.clone()),
                qn: None,
                protocol: stream.url.split(':').next().map(str::to_string),
            })
            .collect(),
    )
}
