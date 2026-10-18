use crate::platforms::common::follow_metadata::{
    douyin_metadata, douyin_needs_directory, parse_douyin_directory, Directory, FollowCategoryMetadata,
};
// DirectoryCache 提升到 common 后仍从本模块导出，douyin_streamer_info 等旧引用保持不变。
pub(crate) use crate::platforms::common::follow_metadata::DirectoryCache;
use reqwest::header::{HeaderValue, REFERER, USER_AGENT};
use serde_json::Value;
use std::future::Future;
use std::time::Duration;

pub(crate) async fn metadata_with_directory<F, Fut>(
    room: &Value,
    cache: &DirectoryCache,
    fetch: F,
) -> FollowCategoryMetadata
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<Directory, String>> + Send + 'static,
{
    let directory = if douyin_needs_directory(room) {
        cache.get_or_fetch(fetch).await
    } else {
        None
    };
    douyin_metadata(room, directory.as_deref())
}

/// 抓取抖音首页并解析官方分类目录；与关注刷新共用 FollowHttpClient 的访客 Cookie。
pub(crate) async fn fetch_douyin_directory_page(
    client: reqwest::Client,
) -> Result<Directory, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(crate::platforms::douyin::web_api::DEFAULT_USER_AGENT),
    );
    headers.insert(REFERER, HeaderValue::from_static("https://live.douyin.com/"));
    let response = client
        .get("https://live.douyin.com/")
        .headers(headers)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("抖音分类目录页请求失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("抖音分类目录页返回 HTTP {status}"));
    }
    let page = response
        .text()
        .await
        .map_err(|e| format!("抖音分类目录页读取失败: {e}"))?;
    parse_douyin_directory(&page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn directory_cache_shares_in_flight_failure_and_retries_then_caches_nonempty_success() {
        let cache = DirectoryCache::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let fail = || {
            let calls = calls.clone();
            move || async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Err("目录暂时不可用".into())
            }
        };
        let (first, second, third) = tokio::join!(
            cache.get_or_fetch(fail()), cache.get_or_fetch(fail()), cache.get_or_fetch(fail()));
        assert!(first.is_none() && second.is_none() && third.is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let retry_calls = calls.clone();
        let retry = cache.get_or_fetch(move || async move {
            retry_calls.fetch_add(1, Ordering::SeqCst);
            Ok(HashMap::from([("8,2".into(), "星际争霸2".into())]))
        }).await.unwrap();
        assert_eq!(retry.get("8,2").map(String::as_str),Some("星际争霸2"));
        let cached = cache.get_or_fetch(|| async { panic!("成功非空目录应被缓存"); }).await.unwrap();
        assert!(Arc::ptr_eq(&retry,&cached));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn empty_directory_is_not_cached_and_failed_lookup_preserves_room_status() {
        let cache = DirectoryCache::default();
        assert!(cache.get_or_fetch(|| async { Ok(HashMap::new()) }).await.is_none());
        let room = json!({"status":2, "partition_road_map":{"partition":{"id_str":"1","type":1,"title":"游戏"},
            "sub_partition":{"partition":{"id_str":"8","type":2}}}});
        let before = room.clone();
        let failed = metadata_with_directory(&room,&cache,||async { Err("目录失败".into()) }).await;
        assert_eq!(room,before);
        assert_eq!(room["status"],2);
        assert_eq!(failed.category_id.as_deref(),Some("8,2"));
        let recovered = metadata_with_directory(&room,&cache,||async {
            Ok(HashMap::from([("8,2".into(),"星际争霸2".into())]))
        }).await;
        assert_eq!(recovered.category_name.as_deref(),Some("星际争霸2"));
        assert_eq!(room["status"],2);
    }
}
