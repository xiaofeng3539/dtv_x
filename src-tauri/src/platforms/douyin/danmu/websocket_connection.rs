use chrono::Utc;
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use log::{debug, warn};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, Sender};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::tungstenite::Error as TungsteniteError;
use tokio_tungstenite::{connect_async, MaybeTlsStream};
use urlencoding;
// use url::Url; // REMOVED AGAIN
// use rand::Rng; // REMOVED AGAIN

// Adjusted imports to use `super` for sibling modules within `danmu`
use super::gen::PushFrame; // Removed ::douyin
use super::signature; // For generate_signature
use super::web_fetcher::DouyinLiveWebFetcher;
use prost::Message as ProstMessage; // For encoding heartbeat

// Define a type alias for the WebSocket stream for brevity
pub type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

const DEFAULT_DOUYIN_WS_HOSTS: &[&str] = &[
    // Prefer hosts observed stable in other projects (pure_live uses webcast3-ws-web-lq + webcast5-ws-web-lf).
    "webcast3-ws-web-lq.douyin.com",
    "webcast5-ws-web-lf.douyin.com",
    "webcast5-ws-web-hl.douyin.com",
    "webcast3-ws-web-hl.douyin.com",
    "webcast3-ws-web-lf.douyin.com",
];

fn build_wss_query(cursor: &str, user_unique_id: &str, room_id: &str) -> String {
    let browser = crate::platforms::douyin::web_api::DEFAULT_USER_AGENT.trim_start_matches("Mozilla/");
    let params = [
        ("app_name", "douyin_web"), ("version_code", "180800"),
        ("webcast_sdk_version", "1.3.0"), ("update_version_code", "1.3.0"),
        ("compress", "gzip"), ("cursor", cursor), ("host", "https://live.douyin.com"),
        ("aid", "6383"), ("live_id", "1"), ("did_rule", "3"), ("debug", "false"),
        ("maxCacheMessageNumber", "20"), ("endpoint", "live_pc"), ("support_wrds", "1"),
        ("im_path", "/webcast/im/fetch/"), ("user_unique_id", user_unique_id),
        ("device_platform", "web"), ("cookie_enabled", "true"),
        ("screen_width", "1920"), ("screen_height", "1080"),
        ("browser_language", "zh-CN"), ("browser_platform", "Win32"),
        ("browser_name", "Mozilla"), ("browser_version", browser), ("browser_online", "true"),
        ("tz_name", "Asia/Shanghai"), ("identity", "audience"), ("room_id", room_id),
        ("heartbeatDuration", "0"),
    ];
    format!("webcast/im/push/v2/?{}", serde_urlencoded::to_string(params).expect("string query"))
}

fn heartbeat_message() -> WsMessage {
    let frame = PushFrame { payload_type: "hb".into(), ..Default::default() };
    WsMessage::Binary(frame.encode_to_vec().into())
}

fn douyin_ws_hosts() -> Vec<String> {
    let env_hosts = std::env::var("DTVX_DOUYIN_WS_HOSTS").ok();
    if let Some(raw) = env_hosts {
        let hosts: Vec<String> = raw
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        if !hosts.is_empty() {
            return hosts;
        }
    }

    DEFAULT_DOUYIN_WS_HOSTS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn log_handshake_http_error(host: &str, err: &TungsteniteError) {
    match err {
        TungsteniteError::Http(resp) => {
            let status = resp.status();
            let server = resp
                .headers()
                .get("server")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let via = resp
                .headers()
                .get("via")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            warn!(
                "[Douyin Danmaku] WebSocket handshake HTTP error from host {}: status={} server='{}' via='{}'",
                host, status, server, via
            );
        }
        _ => {
            warn!(
                "[Douyin Danmaku] WebSocket connect error on host {}: {}",
                host, err
            );
        }
    }
}

// This function will establish the connection and spawn send/heartbeat tasks.
// It returns the read half of the stream and the sender for the outgoing message channel.
pub async fn connect_and_manage_websocket(
    fetcher: &DouyinLiveWebFetcher, // Read-only, used for UA
    room_id: &str,
    cookie_header: &str,
    user_unique_id: &str,
) -> Result<(SplitStream<WsStream>, Sender<WsMessage>, watch::Sender<bool>), Box<dyn std::error::Error + Send + Sync>> {
    let ws_cookie_header = cookie_header.to_string();
    let current_timestamp_ms = Utc::now().timestamp_millis();
    let cursor = format!(
        "h-1_t-{}_r-1_d-1_u-1",
        current_timestamp_ms
    );
    let hosts = douyin_ws_hosts();

    // Compute signature once; it depends on a subset of query params, not on the WS host.
    let signature_url_for_md5 = format!(
        "wss://{}/{}",
        hosts
            .get(0)
            .map(|s| s.as_str())
            .unwrap_or("webcast5-ws-web-hl.douyin.com"),
        build_wss_query(&cursor, user_unique_id, room_id)
    );
    let signature = signature::generate_signature(&signature_url_for_md5).await?;

    let mut last_err: Option<Box<dyn std::error::Error + Send + Sync>> = None;
    let mut last_host: Option<String> = None;
    let mut last_http_status: Option<u16> = None;

    let user_agent = fetcher.user_agent.clone();
    let mut connected: Option<tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>> = None;

    for host in hosts {
        last_host = Some(host.clone());
        let final_wss_url_str = format!(
            "wss://{}/{}&signature={}",
            host,
            build_wss_query(&cursor, user_unique_id, room_id),
            urlencoding::encode(&signature)
        );

        let mut client_request = match final_wss_url_str.into_client_request() {
            Ok(req) => req,
            Err(e) => {
                last_err = Some(Box::new(e));
                continue;
            }
        };

        let headers = client_request.headers_mut();
        headers.insert("accept", "application/json, text/plain, */*".parse()?);
        headers.insert("accept-language", "zh-CN,zh;q=0.9,en;q=0.8".parse()?);
        headers.insert("cache-control", "no-cache".parse()?);
        headers.insert("pragma", "no-cache".parse()?);
        headers.insert("sec-websocket-version", "13".parse()?);
        headers.insert("origin", "https://live.douyin.com".parse()?);
        headers.insert("user-agent", user_agent.parse()?);
        headers.insert("Cookie", ws_cookie_header.parse()?);

        debug!("[Douyin Danmaku] Trying WebSocket host: {}", host);
        match timeout(Duration::from_secs(12), connect_async(client_request)).await {
            Ok(Ok((ws_stream, _response))) => {
                debug!("[Douyin Danmaku] WebSocket connected via host: {}", host);
                connected = Some(ws_stream);
                break;
            }
            Ok(Err(e)) => {
                if let TungsteniteError::Http(resp) = &e {
                    last_http_status = Some(resp.status().as_u16());
                }
                log_handshake_http_error(&host, &e);
                last_err = Some(Box::new(e));
                continue;
            }
            Err(e) => {
                warn!(
                    "[Douyin Danmaku] WebSocket connect timeout on host {}: {}",
                    host, e
                );
                last_err = Some(Box::new(e));
                continue;
            }
        }
    }

    let ws_stream = if let Some(s) = connected {
        s
    } else {
        let host = last_host.unwrap_or_else(|| "<none>".to_string());
        let status_part = last_http_status
            .map(|s| format!("http_status={s}"))
            .unwrap_or_else(|| "http_status=<none>".to_string());
        return Err(format!(
            "All Douyin WebSocket hosts failed (last_host={}, {}): {}",
            host, status_part,
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
        .into());
    };

    let (mut write, read) = ws_stream.split(); // read will be returned

    // Channel for sending messages to the WebSocket Sink
    let (tx, mut rx) = mpsc::channel::<WsMessage>(32);

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    // Spawn task for sending heartbeats and other messages from the channel
    tokio::spawn(async move {
        let heartbeat = heartbeat_message();
        let mut ticker = tokio::time::interval(Duration::from_secs(10));

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                _ = ticker.tick() => {
                    if let Err(e) = write.send(heartbeat.clone()).await {
                        warn!("[Douyin Danmaku] Heartbeat send error: {}", e);
                        break;
                    }
                }
                msg_opt = rx.recv() => {
                    match msg_opt {
                        Some(msg_to_send) => {
                            if let Err(e) = write.send(msg_to_send).await {
                                warn!("[Douyin Danmaku] Send error: {}", e);
                                // Potentially break or signal error if a crucial message (like ACK) fails
                                if matches!(e, tokio_tungstenite::tungstenite::Error::ConnectionClosed |
                                               tokio_tungstenite::tungstenite::Error::AlreadyClosed) {
                                    break; // Stop if connection is closed
                                }
                            }
                        }
                        None => break,
                    }
                }
                else => {
                    // Channel closed, no more messages to send from other tasks
                    break;
                }
            }
        }
        debug!("[Douyin Danmaku] WebSocket send/heartbeat task ended.");
    });

    Ok((read, tx, shutdown_tx)) // Return the read stream and the sender for other tasks to send messages
}

#[cfg(test)]
mod parity_tests {
 use super::*;
 #[test]
 fn websocket_bootstrap_matches_simple_live_sdk_and_browser() {
  let query=build_wss_query("h-1_t-123_r-1_d-1_u-1","456","789");
  let url=url::Url::parse(&format!("wss://example.test/{query}")).unwrap();
  let params=url.query_pairs().into_owned().collect::<std::collections::HashMap<_,_>>();
  assert_eq!(params["webcast_sdk_version"],"1.3.0");assert_eq!(params["update_version_code"],"1.3.0");
  assert_eq!(params["browser_version"],crate::platforms::douyin::web_api::DEFAULT_USER_AGENT.trim_start_matches("Mozilla/"));
  assert_eq!(params["maxCacheMessageNumber"],"20");assert_eq!(params["debug"],"false");
  assert!(!params.contains_key("internal_ext"));
 }
 #[test]
 fn heartbeat_uses_simple_live_binary_push_frame() {
  let WsMessage::Binary(bytes)=heartbeat_message() else {panic!("应用心跳应为二进制PushFrame，而非WebSocket Ping");};
  let frame=PushFrame::decode(bytes.as_ref()).unwrap();assert_eq!(frame.payload_type,"hb");
 }

}
