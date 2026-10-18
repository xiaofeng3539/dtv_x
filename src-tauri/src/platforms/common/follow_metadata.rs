use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct FollowCategoryMetadata {
    #[serde(default)]
    pub category_name: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub popularity: Option<f64>,
}

pub type Directory = HashMap<String, String>;

/// 目录缓存槽位（斗鱼/抖音共用）：
/// - Ready：非空目录已缓存，后续调用直接复用（Arc 同一实例）；
/// - Running：同一时刻只允许一个目录请求在飞，后来者共享该次结果；
/// - Empty：失败或空目录不缓存，允许下次重试。
enum DirectorySlot {
    Empty,
    Running(watch::Receiver<Option<Arc<Directory>>>),
    Ready(Arc<Directory>, std::time::Instant),
}

/// 分类目录缓存：目录补查共享请求、缓存成功非空结果；
/// 失败或空结果不永久缓存，下一次需要时会重新请求。
pub struct DirectoryCache {
    slot: Mutex<DirectorySlot>,
}

impl Default for DirectoryCache {
    fn default() -> Self {
        Self { slot: Mutex::new(DirectorySlot::Empty) }
    }
}

impl DirectoryCache {
    pub async fn get_or_fetch<F, Fut>(&self, fetch: F) -> Option<Arc<Directory>>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<Directory, String>> + Send + 'static,
    {
        enum Step {
            Ready(Arc<Directory>),
            Initiate(watch::Sender<Option<Arc<Directory>>>),
            Wait(watch::Receiver<Option<Arc<Directory>>>),
        }
        let step = {
            let mut slot = self.slot.lock().unwrap();
            match &mut *slot {
                DirectorySlot::Ready(directory, fetched_at)
                    if fetched_at.elapsed() < std::time::Duration::from_secs(300) => Step::Ready(directory.clone()),
                DirectorySlot::Running(receiver) if receiver.has_changed().is_ok() => Step::Wait(receiver.clone()),
                // 发起任务取消会关闭 watch；过期目录和关闭的请求均允许重新获取。
                _ => {
                    let (sender, receiver) = watch::channel(None);
                    *slot = DirectorySlot::Running(receiver);
                    Step::Initiate(sender)
                }
            }
        };
        match step {
            Step::Ready(directory) => Some(directory),
            Step::Initiate(sender) => {
                // 分类目录补查失败只影响分类名，不改变直播状态或播放结果。
                let result = fetch().await;
                let outcome = match result {
                    Ok(directory) if !directory.is_empty() => Some(Arc::new(directory)),
                    _ => None,
                };
                let mut slot = self.slot.lock().unwrap();
                match outcome {
                    Some(directory) => {
                        *slot = DirectorySlot::Ready(directory.clone(), std::time::Instant::now());
                        let _ = sender.send(Some(directory.clone()));
                        Some(directory)
                    }
                    None => {
                        *slot = DirectorySlot::Empty;
                        let _ = sender.send(None);
                        None
                    }
                }
            }
            Step::Wait(mut receiver) => {
                // 发起方总会 send 一次后释放；sender drop 且无新值时视为失败。
                if receiver.changed().await.is_err() {
                    return None;
                }
                receiver.borrow_and_update().clone()
            }
        }
    }
}

/// 与前端 followGrouping.ts 的判定一致：去掉首尾空白和末尾“专区”后，
/// 空字符串 / null / undefined / 0 / 未知 / 未分类 / 其他（忽略大小写）视为无效。
/// 只使用平台官方返回的分类字段，不从昵称或标题推测。
fn valid_category_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let stripped = trimmed.strip_suffix("专区").map(|s| s.trim_end()).unwrap_or(trimmed);
    let name = stripped.trim();
    if name.is_empty() {
        return None;
    }
    let key = name.to_lowercase();
    if matches!(key.as_str(), "null" | "undefined" | "0" | "未知" | "未分类" | "其他") {
        return None;
    }
    Some(name.to_string())
}

/// 数字或数字字符串；负数、NaN、解析失败一律视为缺失，不伪造为 0。
fn numeric_field(value: Option<&Value>) -> Option<f64> {
    let raw = value?;
    let num = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<f64>().ok()))?;
    if !num.is_finite() || num < 0.0 {
        return None;
    }
    Some(num)
}

/// 分类 ID：数字或字符串均可，空串和 "0" 视为缺失；按候选键顺序取第一个有效的。
fn id_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(raw) = value.get(*key) else { continue };
        let id = match raw {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.trim().to_string(),
            _ => continue,
        };
        if !id.is_empty() && id != "0" {
            return Some(id);
        }
    }
    None
}

fn name_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

/// 按候选顺序取第一个有效名称；ID 键与名称层级配对。
fn pick_name_and_id(room: &Value, candidates: &[(&str, &[&str])]) -> (Option<String>, Option<String>) {
    for (name_key, id_keys) in candidates {
        if let Some(raw) = name_field(room, name_key) {
            if let Some(name) = valid_category_name(raw) {
                return (Some(name), id_field(room, id_keys));
            }
        }
    }
    (None, None)
}

pub fn bilibili_metadata(room: &Value) -> FollowCategoryMetadata {
    // 具体分区（second_area）优先，其次 area，最后父分区。
    let (name, id) = pick_name_and_id(
        room,
        &[
            ("second_area_name", &["second_area_id", "area_id"]),
            ("area_name", &["area_id"]),
            ("parent_area_name", &["parent_area_id"]),
        ],
    );
    FollowCategoryMetadata {
        category_name: name,
        category_id: id,
        popularity: numeric_field(room.get("online")),
    }
}

pub fn douyu_metadata(room: &Value, directory: Option<&HashMap<String, String>>) -> FollowCategoryMetadata {
    // betard 真实响应：二级分类名在 second_lvl_name（cate2_name 系列不存在，保留作兼容候选）；
    // 热度在 room_biz_all.hot（字符串），dart 同源。
    let (name, picked_id) = pick_name_and_id(
        room,
        &[
            ("second_lvl_name", &["cate2_id", "cate2Id", "cate_id"]),
            ("cate2_name", &["cate2Id", "cate2_id", "cate_id"]),
            ("cate2Name", &["cate2Id", "cate2_id", "cate_id"]),
            ("cate_name", &["cate_id"]),
            ("cateName", &["cate_id"]),
            ("cate1_name", &["cate1_id", "cate1Id", "cate_id"]),
        ],
    );
    // 名称全部缺失时 pick 不返回 ID；只有 ID 的房间（betard 真实场景）独立补取，
    // 供目录映射和"保留 ID 下次补齐"使用。
    let id = picked_id.or_else(|| id_field(room, &["cate2_id", "cate2Id", "cate_id", "cate1_id"]));
    // 名称全部缺失但有有效分类 ID 时，用官方分类目录（m.douyu.com/api/cate/list）映射补齐。
    // ★ 斗鱼 cate1Id 与 cate2Id 是两个独立 ID 空间（cate1Id=1 网游竞技、cate2Id=1 英雄联盟），
    //   目录 key 必须按层级隔离（c2:{id} / c1:{id}），否则映射互相覆盖。
    let (name, id) = match (name, id) {
        (Some(name), id) => (Some(name), id),
        (None, id) => {
            let from_directory = directory.and_then(|map| {
                id_field(room, &["cate2_id", "cate2Id"])
                    .and_then(|key| map.get(&format!("c2:{key}")).cloned())
                    .or_else(|| {
                        id_field(room, &["cate1_id", "cate1Id"])
                            .and_then(|key| map.get(&format!("c1:{key}")).cloned())
                    })
            });
            match from_directory.and_then(|s| valid_category_name(&s)) {
                Some(mapped) => (Some(mapped), id),
                None => (None, id),
            }
        }
    };
    let hot = room
        .pointer("/room_biz_all/hot")
        .or_else(|| room.get("hot"));
    FollowCategoryMetadata {
        category_name: name,
        category_id: id,
        popularity: numeric_field(hot),
    }
}

/// 斗鱼：名称候选全部落空但存在有效分类 ID 时需要目录补查。
pub fn douyu_needs_directory(room: &Value) -> bool {
    let (name, _) = pick_name_and_id(
        room,
        &[
            ("second_lvl_name", &["cate2_id", "cate2Id", "cate_id"]),
            ("cate2_name", &["cate2Id", "cate2_id", "cate_id"]),
            ("cate2Name", &["cate2Id", "cate2_id", "cate_id"]),
            ("cate_name", &["cate_id"]),
            ("cateName", &["cate_id"]),
            ("cate1_name", &["cate1_id", "cate1Id", "cate_id"]),
        ],
    );
    name.is_none() && id_field(room, &["cate2_id", "cate2Id", "cate_id", "cate1_id"]).is_some()
}

/// 斗鱼官方分类目录（m.douyu.com/api/cate/list）解析：
/// cate2Id → "c2:{id}"（510 个具体游戏）+ cate1Id → "c1:{id}"（一级大类）。
/// 两级 ID 空间独立，必须用前缀隔离，防止 cate1Id 与 cate2Id 数值相同时互相覆盖。
/// 目录映射按平台隔离，分类识别不得依赖菜单是否列出该游戏——
/// 该映射只是"只有 ID 时补名称"，不是识别白名单。
pub fn parse_douyu_directory(body: &str) -> Result<HashMap<String, String>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|e| format!("斗鱼分类目录 JSON 解析失败: {e}"))?;
    let mut directory = HashMap::<String, String>::new();
    let insert_entries = |list: Option<&Value>, prefix: &str, id_key: &str, name_key: &str, directory: &mut HashMap<String, String>| {
        for entry in list.and_then(|v| v.as_array()).into_iter().flatten() {
            let id = id_field(entry, &[id_key]);
            let name = name_field(entry, name_key).and_then(valid_category_name);
            if let (Some(id), Some(name)) = (id, name) {
                directory.insert(format!("{prefix}:{id}"), name);
            }
        }
    };
    insert_entries(value.pointer("/data/cate2Info"), "c2", "cate2Id", "cate2Name", &mut directory);
    insert_entries(value.pointer("/data/cate1Info"), "c1", "cate1Id", "cate1Name", &mut directory);
    if directory.is_empty() {
        return Err("未找到斗鱼分类目录数据".into());
    }
    Ok(directory)
}

pub fn huya_metadata(profile: &Value) -> FollowCategoryMetadata {
    // 优先房间返回的游戏全名（gameFullName），其次短名（gameName）；热度取 totalCount。
    let null = Value::Null;
    let live = profile
        .pointer("/data/liveData")
        .or_else(|| profile.pointer("/data/profileInfo"))
        .unwrap_or(&null);
    let (name, id) = pick_name_and_id(
        live,
        &[
            ("gameFullName", &["gid", "gameId"]),
            ("gameName", &["gid", "gameId"]),
        ],
    );
    FollowCategoryMetadata {
        category_name: name,
        category_id: id,
        popularity: numeric_field(live.get("totalCount")),
    }
}

pub fn twitch_metadata(user: &Value) -> FollowCategoryMetadata {
    let null = Value::Null;
    let stream = user.get("stream").unwrap_or(&null);
    // 同次关注快照：直播实际游戏优先，离线/直播游戏缺失时读频道广播设置。
    let mut category = (None, None);
    for game in [stream.get("game"), user.pointer("/broadcastSettings/game")].into_iter().flatten() {
        category = pick_name_and_id(game, &[("displayName", &["id"]), ("name", &["id"])]);
        if category.0.is_some() { break; }
    }
    FollowCategoryMetadata {
        category_name: category.0,
        category_id: category.1,
        popularity: numeric_field(stream.get("viewersCount")),
    }
}

/// 抖音分区键："{id},{type}"，与 dart_simple_live 的 douyinWebPartitionId 一致。
fn douyin_partition_key(partition: &Value) -> Option<String> {
    let id = match partition.get("id_str").or_else(|| partition.get("id"))? {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        _ => return None,
    };
    let ty = partition.get("type").and_then(|v| v.as_i64())?;
    if id.is_empty() || id == "0" {
        return None;
    }
    Some(format!("{},{}", id, ty))
}

/// 沿 partition_road_map 的 sub_partition 对象链取最深分区路径。
fn douyin_partition_path(room: &Value) -> Vec<&Value> {
    let mut path = Vec::new();
    let mut node = room.get("partition_road_map");
    while let Some(current) = node {
        let partition = match current.get("partition") {
            Some(p) => p,
            None => break,
        };
        path.push(partition);
        node = current.get("sub_partition").filter(|v| !v.is_null());
    }
    path
}

/// Simple Live 同策略：API/网页的 room 与外层 roomInfo 路径都保留最深者。
/// 只合并分类元数据，不改变直播状态、房号或播放流。
pub(crate) fn preserve_douyin_partition(room: &mut Value, room_info: &Value) {
    let depth = douyin_partition_path(room_info).len();
    if depth > 0 && depth >= douyin_partition_path(room).len() {
        if let Some(path) = room_info.get("partition_road_map").cloned() {
            if let Some(object) = room.as_object_mut() {
                object.insert("partition_road_map".into(), path);
            }
        }
    }
}

fn douyin_ancestor_name(path: &[&Value], skip_deepest: usize) -> Option<String> {
    path[..path.len() - skip_deepest]
        .iter()
        .rev()
        .find_map(|partition| {
            let title = name_field(partition, "title")?;
            // 顶级“游戏”大类不作分类名，与 dart_simple_live 的回退规则一致。
            let name = valid_category_name(title)?;
            if name == "游戏" {
                None
            } else {
                Some(name)
            }
        })
}

pub fn douyin_needs_directory(room: &Value) -> bool {
    let path = douyin_partition_path(room);
    match path.last() {
        Some(deepest) => {
            let title_valid = name_field(deepest, "title").and_then(valid_category_name).is_some();
            !title_valid && douyin_partition_key(deepest).is_some()
        }
        None => false,
    }
}

pub fn douyin_metadata(room: &Value, directory: Option<&HashMap<String, String>>) -> FollowCategoryMetadata {
    let path = douyin_partition_path(room);
    // 最深层官方分区优先；缺标题但有 ID 时查目录，仍失败再回退上级分区。
    let (name, id) = match path.last() {
        Some(&deepest) => {
            let key = douyin_partition_key(deepest);
            let title = name_field(deepest, "title").and_then(valid_category_name);
            match (title, key) {
                (Some(title), id) => (Some(title), id),
                (None, Some(key)) => {
                    let from_directory = directory
                        .and_then(|map| map.get(&key))
                        .and_then(|s| valid_category_name(s))
                        .filter(|name| name != "游戏");
                    match from_directory {
                        Some(name) => (Some(name), Some(key)),
                        // 保留最深分区 ID，便于下次目录恢复后补齐（dart 同策略）。
                        None => (douyin_ancestor_name(&path, 1), Some(key)),
                    }
                }
                (None, None) => (douyin_ancestor_name(&path, 1), None),
            }
        }
        // 无官方分区路径时退回接口返回的 game_name，仍不猜标题/昵称。
        None => (name_field(room, "game_name").and_then(valid_category_name), None),
    };
    FollowCategoryMetadata {
        category_name: name,
        category_id: id,
        popularity: numeric_field(room.get("user_count")),
    }
}

/// 支持普通 JSON、带 Flight 行前缀的 next/pace chunk 以及多层字符串转义。
/// 使用 JSON 解码器读取完整数组，分类名中的引号、反斜杠和方括号不会截断目录。
pub fn parse_douyin_directory(page: &str) -> Result<HashMap<String, String>, String> {
    let strings = regex::Regex::new(r#""(?:\\.|[^"\\])*""#).map_err(|e| e.to_string())?;
    let chunks = regex::Regex::new(
        r#"self\.__(?:next|pace)_f\.push\(\s*\[\s*\d+\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)"#
    ).map_err(|e| e.to_string())?;
    let mut directory = HashMap::<String, String>::new();
    collect_douyin_directory_text(page, &strings, 0, &mut directory);
    let decoded: Vec<String> = chunks.captures_iter(page)
        .filter_map(|chunk| serde_json::from_str::<String>(&chunk[1]).ok()).collect();
    // Flight 的一个 JSON 值可以跨多个 chunk，既单独读取也按原顺序拼接读取。
    if !decoded.is_empty() {
        collect_douyin_directory_text(&decoded.concat(), &strings, 0, &mut directory);
    }
    if directory.is_empty() { return Err("未找到抖音分类目录数据".into()); }
    Ok(directory)
}

fn collect_douyin_directory_text(
    text: &str,
    strings: &regex::Regex,
    depth: usize,
    directory: &mut Directory,
) {
    if let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(text) {
        for entry in &entries { collect_douyin_partitions(entry, directory); }
    }
    for (index, _) in text.match_indices("categoryData") {
        let rest = &text[index + "categoryData".len()..];
        let Some(colon) = rest.find(':') else { continue; };
        if colon > 12 { continue; }
        let value = rest[colon + 1..].trim_start();
        if !value.starts_with('[') { continue; }
        if let Some(Ok(Value::Array(entries))) = serde_json::Deserializer::from_str(value)
            .into_iter::<Value>().next() {
            for entry in &entries { collect_douyin_partitions(entry, directory); }
        }
    }
    if depth >= 4 { return; }
    for literal in strings.find_iter(text) {
        if !literal.as_str().contains("categoryData") { continue; }
        if let Ok(decoded) = serde_json::from_str::<String>(literal.as_str()) {
            collect_douyin_directory_text(&decoded, strings, depth + 1, directory);
        }
    }
}

fn collect_douyin_partitions(node: &Value, directory: &mut HashMap<String, String>) {
    if let Some(partition) = node.get("partition") {
        if let (Some(key), Some(title)) = (
            douyin_partition_key(partition),
            name_field(partition, "title"),
        ) {
            if let Some(name) = valid_category_name(title) { directory.insert(key, name); }
        }
    }
    match node.get("sub_partition") {
        Some(Value::Array(items)) => {
            for item in items {
                collect_douyin_partitions(item, directory);
            }
        }
        Some(single @ Value::Object(_)) => collect_douyin_partitions(single, directory),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bilibili_specific_category_precedes_parent_and_preserves_popularity() {
        let result = bilibili_metadata(&json!({"second_area_name": "星际争霸2", "area_name": "游戏", "parent_area_name": "网游", "area_id": 88, "online": 1200}));
        assert_eq!(result.category_name.as_deref(), Some("星际争霸2"));
        assert_eq!(result.category_id.as_deref(), Some("88"));
        assert_eq!(result.popularity, Some(1200.0));
        assert_eq!(bilibili_metadata(&json!({"area_name": "", "parent_area_name":"生活", "parent_area_id": 10})).category_name.as_deref(), Some("生活"));
    }

    #[test]
    fn douyu_second_category_precedes_parent_and_supports_numeric_strings() {
        // 真实 betard 结构：second_lvl_name 是二级分类名，hot 在 room_biz_all 下（字符串）。
        let result = douyu_metadata(&json!({"second_lvl_name":"DOTA2", "cate2_id":3, "cate1_id":1, "room_biz_all":{"hot":"4804628"}}), None);
        assert_eq!(result.category_name.as_deref(), Some("DOTA2"));
        assert_eq!(result.category_id.as_deref(), Some("3"));
        assert_eq!(result.popularity, Some(4804628.0));
        assert_eq!(douyu_metadata(&json!({"cate1_name":"户外"}), None).category_name.as_deref(), Some("户外"));
        assert_eq!(douyu_metadata(&json!({"hot":"98765"}), None).popularity, Some(98765.0));
    }

    #[test]
    fn douyu_id_only_room_resolves_directory_before_giving_up() {
        // betard 只有分类 ID、second_lvl_name 缺失的真实场景。
        let room = json!({"cate2_id":3, "cate1_id":1, "room_biz_all":{"hot":123}});
        assert!(douyu_needs_directory(&room));
        let directory = HashMap::from([
            ("c2:3".to_string(), "DOTA2".to_string()),
            ("c1:1".to_string(), "网游竞技".to_string()),
        ]);
        let result = douyu_metadata(&room, Some(&directory));
        assert_eq!(result.category_name.as_deref(), Some("DOTA2"));
        assert_eq!(result.category_id.as_deref(), Some("3"));
        // 目录失败不缓存、不伪造：保留 ID 供下次补齐，名称归其他。
        let failed = douyu_metadata(&room, None);
        assert_eq!(failed.category_name, None);
        assert_eq!(failed.category_id.as_deref(), Some("3"));
        // 只有 cate1_id 时回退一级大类。
        let cate1_only = json!({"cate1_id":1});
        assert_eq!(douyu_metadata(&cate1_only, Some(&directory)).category_name.as_deref(), Some("网游竞技"));
        // 有名称的房间不需要目录。
        assert!(!douyu_needs_directory(&json!({"second_lvl_name":"英雄联盟", "cate2_id":1})));
        assert!(!douyu_needs_directory(&json!({"nickname":"主播"})));
    }

    #[test]
    fn douyu_directory_parses_official_cate_list() {
        // m.douyu.com/api/cate/list 真实结构（截取）：
        // cate1Id=1（网游竞技）与 cate2Id=1（英雄联盟）数值相同但层级不同，必须隔离。
        let body = r#"{"data":{"cate1Info":[{"cate1Id":1,"cate1Name":"网游竞技","shortName":"PCgame"}],
            "cate2Info":[{"cate1Id":1,"cate2Id":1,"cate2Name":"英雄联盟","shortName":"LOL"},
            {"cate1Id":1,"cate2Id":3,"cate2Name":"DOTA2","shortName":null}]}}"#;
        let directory = parse_douyu_directory(body).unwrap();
        assert_eq!(directory.get("c2:3").map(String::as_str), Some("DOTA2"));
        assert_eq!(directory.get("c2:1").map(String::as_str), Some("英雄联盟"));
        assert_eq!(directory.get("c1:1").map(String::as_str), Some("网游竞技"));
        assert_eq!(directory.get("c2:999"), None);
        assert!(parse_douyu_directory(r#"{"data":{}}"#).is_err());
        assert!(parse_douyu_directory("not json").is_err());
    }

    #[test]
    fn huya_prefers_game_full_name_and_profile_live_data() {
        let result = huya_metadata(&json!({"data":{"liveData":{"gameFullName":"星际争霸2", "gameName":"星际", "gameId":8,"totalCount":"12345"}}}));
        assert_eq!(result.category_name.as_deref(), Some("星际争霸2"));
        assert_eq!(result.category_id.as_deref(), Some("8"));
        assert_eq!(result.popularity, Some(12345.0));
        assert_eq!(huya_metadata(&json!({"data":{"liveData":{"gameName":"户外"}}})).category_name.as_deref(), Some("户外"));
    }

    #[test]
    fn twitch_uses_game_and_current_stream_viewers() {
        let result = twitch_metadata(&json!({"stream":{"game":{"id":"490","displayName":"StarCraft II"},"viewersCount":42}}));
        assert_eq!(result.category_name.as_deref(), Some("StarCraft II"));
        assert_eq!(result.category_id.as_deref(), Some("490"));
        assert_eq!(result.popularity, Some(42.0));
    }

    fn douyin_path() -> Value {
        json!({"title":"标题不应参与分类", "owner":{"nickname":"英雄联盟"}, "user_count":123,
            "partition_road_map":{"partition":{"id_str":"1","type":1,"title":"游戏"},
                "sub_partition":{"partition":{"id_str":"2","type":2,"title":"单机游戏"},
                    "sub_partition":{"partition":{"id_str":"8","type":2,"title":"星际争霸2"}}}}})
    }

    #[test]
    fn douyin_deepest_official_partition_precedes_game_fields() {
        let mut room = douyin_path();
        room["game_name"] = json!("英雄联盟");
        let result = douyin_metadata(&room, None);
        assert_eq!(result.category_name.as_deref(), Some("星际争霸2"));
        assert_eq!(result.category_id.as_deref(), Some("8,2"));
        assert_eq!(result.popularity, Some(123.0));
        assert!(!douyin_needs_directory(&room));
    }

    #[test]
    fn douyin_id_only_leaf_resolves_directory_before_parent_fallback() {
        let mut room = douyin_path();
        room["partition_road_map"]["sub_partition"]["sub_partition"]["partition"].as_object_mut().unwrap().remove("title");
        assert!(douyin_needs_directory(&room));
        let directory = HashMap::from([("8,2".into(),"星际争霸2".into())]);
        let result = douyin_metadata(&room, Some(&directory));
        assert_eq!(result.category_name.as_deref(), Some("星际争霸2"));
        assert_eq!(result.category_id.as_deref(), Some("8,2"));
        assert_eq!(douyin_metadata(&room, None).category_name.as_deref(), Some("单机游戏"));
    }

    #[test]
    fn all_platforms_missing_fields_stay_optional_and_ignore_title_and_nickname() {
        let room = json!({"title":"英雄联盟", "nickname":"星际争霸2", "area_name":"未知", "game_name":"未分类", "online":-1, "hot":"not numeric"});
        for result in [bilibili_metadata(&room), douyu_metadata(&room, None), huya_metadata(&room), twitch_metadata(&room), douyin_metadata(&room,None)] {
            assert_eq!(result, FollowCategoryMetadata::default());
        }
        assert_eq!(twitch_metadata(&json!({"stream":null})), FollowCategoryMetadata::default());
    }

    #[test]
    fn douyin_directory_supports_nested_list_and_escaped_next_payload() {
        let data = json!([{"partition":{"id_str":"1","type":1,"title":"游戏"},"sub_partition":[
            {"partition":{"id_str":"2","type":2,"title":"单机游戏"},"sub_partition":[
                {"partition":{"id_str":"8","type":2,"title":"星际争霸2"}}]}]}]);
        let raw = format!("{{\"categoryData\":{data}}}");
        let escaped = format!("<script>self.__next_f.push([1,{}])</script>", serde_json::to_string(&raw).unwrap());
        for page in [raw,escaped] {
            let directory = parse_douyin_directory(&page).unwrap();
            assert_eq!(directory.get("8,2").map(String::as_str),Some("星际争霸2"));
            assert_eq!(directory.get("2,2").map(String::as_str),Some("单机游戏"));
        }
        assert!(parse_douyin_directory("no categories").is_err());
    }

    #[test]
    fn metadata_serializes_snake_case_and_missing_fields_deserialize() {
        let result = bilibili_metadata(&json!({"area_name":"星际争霸2", "area_id":8}));
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized["category_name"], "星际争霸2");
        assert_eq!(serialized["category_id"], "8");
        assert!(serialized.get("categoryName").is_none());
        assert_eq!(serde_json::from_value::<FollowCategoryMetadata>(json!({})).unwrap(), FollowCategoryMetadata::default());
    }

    #[test]
    fn parity_huya_official_gid_is_preserved_with_game_name() {
        let result = huya_metadata(&json!({"status":200,"data":{"liveData":{"gameFullName":"英雄联盟","gid":1}}}));
        assert_eq!(result.category_name.as_deref(),Some("英雄联盟"));
        assert_eq!(result.category_id.as_deref(),Some("1"));
    }

    #[test]
    fn parity_douyin_flight_prefix_multiple_chunks_and_string_escaping() {
        let data = json!([{"partition":{"id_str":"103","type":4,"title":"游戏"},"sub_partition":[
            {"partition":{"id_str":"2","type":1,"title":"主机游戏"},"sub_partition":[
                {"partition":{"id_str":"1010014","type":1,"title":"我的世界"}},
                {"partition":{"id_str":"8","type":1,"title":"带 \" 引号 ] 和 \\ 的游戏"}}]}]}]);
        let flight = format!("7:[\"$\",\"$L1\",null,{{\"categoryData\":{data},\"children\":\"$L2\"}}]\n");
        let escaped = serde_json::to_string(&flight).unwrap();
        for payload in [flight.clone(), escaped] {
            let page = format!("<script>self.__next_f.push([1,\"0:unrelated\\n\"])</script><script>self.__pace_f.push([1,{}])</script>", serde_json::to_string(&payload).unwrap());
            let directory = parse_douyin_directory(&page).unwrap();
            assert_eq!(directory.get("1010014,1").map(String::as_str),Some("我的世界"));
            assert_eq!(directory.get("8,1").map(String::as_str),Some("带 \" 引号 ] 和 \\ 的游戏"));
        }
    }

    #[test]
    fn parity_douyin_directory_does_not_cache_blank_or_invalid_names() {
        let page = r#"{"categoryData":[{"partition":{"id_str":"9","type":1,"title":" 未分类 "}}]}"#;
        assert!(parse_douyin_directory(page).is_err());
    }

    #[tokio::test]
    async fn parity_directory_cache_recovers_after_request_owner_is_cancelled() {
        let cache = Arc::new(DirectoryCache::default());
        let owner_cache = cache.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(async move {
            owner_cache.get_or_fetch(move || async move {
                let _ = started_tx.send(());
                std::future::pending::<Result<Directory,String>>().await
            }).await
        });
        started_rx.await.unwrap();
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        let recovered = tokio::time::timeout(std::time::Duration::from_millis(200),
            cache.get_or_fetch(||async { Ok(HashMap::from([("8,1".into(),"星际争霸2".into())])) })
        ).await.unwrap().expect("取消的发起方不得永久占用 Running 槽位");
        assert_eq!(recovered.get("8,1").map(String::as_str),Some("星际争霸2"));
    }

    #[test]
    fn parity_twitch_offline_and_missing_stream_game_fall_back_to_broadcast_settings() {
        let settings = json!({"game":{"id":"18122","displayName":"World of Warcraft"}});
        for stream in [Value::Null,json!({"viewersCount":0}),json!({"game":null,"viewersCount":12})] {
            let user = json!({"stream":stream,"broadcastSettings":settings});
            let result = twitch_metadata(&user);
            assert_eq!(result.category_name.as_deref(),Some("World of Warcraft"));
            assert_eq!(result.category_id.as_deref(),Some("18122"));
            assert_eq!(result.popularity,numeric_field(user["stream"].get("viewersCount")));
        }
        let user = json!({"stream":{"game":{"id":"490","displayName":"StarCraft II"},"viewersCount":99},
            "broadcastSettings":settings});
        let result = twitch_metadata(&user);
        assert_eq!(result.category_name.as_deref(),Some("StarCraft II"));
        assert_eq!(result.category_id.as_deref(),Some("490"));
        assert_eq!(result.popularity,Some(99.0));
        assert_eq!(twitch_metadata(&json!({"stream":null,"broadcastSettings":null})),FollowCategoryMetadata::default());
    }

    #[tokio::test]
    async fn parity_directory_missing_key_recovers_when_successful_cache_expires() {
        let cache = DirectoryCache::default();
        let first = cache.get_or_fetch(||async { Ok(HashMap::from([("1,1".into(),"射击游戏".into())])) }).await.unwrap();
        assert!(!first.contains_key("1010032,1"));
        // 模拟真实缓存已达到 5 分钟 TTL，而不是为了一个缺失 ID 逐主播重复请求。
        {
            let mut slot = cache.slot.lock().unwrap();
            if let DirectorySlot::Ready(_, fetched_at) = &mut *slot {
                *fetched_at = std::time::Instant::now() - std::time::Duration::from_secs(301);
            } else { panic!("成功非空目录应已缓存"); }
        }
        let renewed = cache.get_or_fetch(||async {
            Ok(HashMap::from([("1,1".into(),"射击游戏".into()),("1010032,1".into(),"和平精英".into())]))
        }).await.unwrap();
        assert_eq!(renewed.get("1010032,1").map(String::as_str),Some("和平精英"));
        assert!(!Arc::ptr_eq(&first,&renewed));
    }
}
