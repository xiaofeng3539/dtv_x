import type { FollowedStreamer, Platform } from "./FollowProvider";

const CATEGORY_ALIASES: Record<string, string> = {
  lol: "英雄联盟",
  "league of legends": "英雄联盟",
  "英雄联盟（lol）": "英雄联盟",
  valorant: "无畏契约",
  pubg: "绝地求生",
  minecraft: "我的世界",
  "naraka: bladepoint": "永劫无间",
  cs2: "CS2",
  "counter-strike 2": "CS2",
  "dota 2": "DOTA2",
  dota2: "DOTA2"
};
const INVALID_CATEGORIES = new Set(["", "null", "undefined", "0", "未知", "未分类", "其他"]);
const DEFAULT_PLATFORM_ORDER: readonly Platform[] = ["DOUYU", "HUYA", "DOUYIN", "BILIBILI", "TWITCH"];

/** 只使用平台返回的分类，不从昵称或房间标题推测游戏。 */
export function normalizeFollowCategory(value: unknown): string {
  if (typeof value !== "string") return "其他";
  const name = value.trim().replace(/\s*专区$/, "").trim();
  const key = name.toLowerCase();
  return INVALID_CATEGORIES.has(key) ? "其他" : CATEGORY_ALIASES[key] ?? name;
}

function validPopularity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 与 Simple Live FollowUser 一致：直播状态和热度仅属于本次运行，不进入缓存、导出或同步。 */
export function stripFollowRuntime<T extends object>(streamer: T): T {
  const next = { ...streamer } as T & { popularity?: number };
  delete next.popularity;
  delete (next as Record<string, unknown>).liveStatus;
  return next;
}

/** 合并两个持久化来源，旧版本/空字段不会抹掉已有有效分类。 */
export function reconcileFollowMetadata(streamer: FollowedStreamer, stored: Partial<FollowedStreamer>): FollowedStreamer {
  const next = { ...stripFollowRuntime({ ...streamer, ...stored, id: streamer.id, platform: streamer.platform }), liveStatus: "UNKNOWN" as const };
  const incoming = normalizeFollowCategory(stored.categoryName);
  const previous = normalizeFollowCategory(streamer.categoryName);
  if (incoming !== "其他") {
    next.categoryName = incoming;
    const id = String(stored.categoryId ?? "").trim();
    if (id && id !== "0") next.categoryId = id;
    else if (incoming !== previous) delete next.categoryId;
  } else if (previous !== "其他") {
    next.categoryName = previous;
    next.categoryId = streamer.categoryId;
  } else {
    delete next.categoryName;
    delete next.categoryId;
  }
  return next;
}

/** 有效官方分类不受直播状态限制；失败/空值回退缓存，缺失热度不是零。 */
export function mergeFollowMetadata(streamer: FollowedStreamer, patch: Partial<FollowedStreamer>): FollowedStreamer {
  const next: FollowedStreamer = { ...streamer, ...patch, id: streamer.id, platform: streamer.platform };
  const category = normalizeFollowCategory(patch.categoryName);
  // ★ 分类与直播状态解耦：斗鱼 betard / B站 room_info / 虎牙 profileRoom 在主播
  //   未开播时同样返回官方分类字段（真实响应已验证）——只要本次补丁带来有效分类
  //   就接受；无效（空/“其他”/未知）或缺失时保留旧缓存，不用“其他”覆盖。
  if (category !== "其他") {
    next.categoryName = category;
    const categoryId = String(patch.categoryId ?? "").trim();
    if (categoryId && categoryId !== "0") next.categoryId = categoryId;
    else if (category !== normalizeFollowCategory(streamer.categoryName)) delete next.categoryId;
    else next.categoryId = streamer.categoryId;
  } else {
    if (streamer.categoryName !== undefined) next.categoryName = streamer.categoryName;
    else delete next.categoryName;
    if (streamer.categoryId !== undefined) next.categoryId = streamer.categoryId;
    else delete next.categoryId;
  }
  if (next.liveStatus !== "LIVE" || !validPopularity(next.popularity)) delete next.popularity;
  if (next.categoryId === undefined) delete next.categoryId;
  const keys = Object.keys(next) as Array<keyof FollowedStreamer>;
  if (keys.length === Object.keys(streamer).length && keys.every((key) => next[key] === streamer[key])) return streamer;
  return next;
}

export type FollowGameGroup = {
  key: string;
  name: string;
  members: FollowedStreamer[];
  liveCount: number;
};

export function buildFollowGameGroups(
  streamers: readonly FollowedStreamer[],
  platformFilter: "ALL" | Platform,
  statusFilter: "ALL" | "LIVE" | "OFFLINE",
  platformOrder: readonly Platform[] = DEFAULT_PLATFORM_ORDER,
  previousOrder: readonly string[] = []
): FollowGameGroup[] {
  const groups = new Map<string, FollowGameGroup>();
  const seen = new Set<string>();
  for (const streamer of streamers) {
    if (platformFilter !== "ALL" && streamer.platform !== platformFilter) continue;
    if (statusFilter !== "ALL" && streamer.liveStatus !== statusFilter) continue;
    const identity = `${streamer.platform}:${streamer.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const name = normalizeFollowCategory(streamer.categoryName);
    const key = name.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { key, name, members: [], liveCount: 0 };
      groups.set(key, group);
    }
    group.members.push(streamer);
    if (streamer.liveStatus === "LIVE") group.liveCount += 1;
  }
  const ranks = new Map(platformOrder.map((platform, index) => [platform, index]));
  const previousRanks = new Map(previousOrder.map((key, index) => [key, index]));
  for (const group of groups.values()) {
    group.members.sort((a, b) => {
      const rank = (ranks.get(a.platform) ?? platformOrder.length) - (ranks.get(b.platform) ?? platformOrder.length);
      if (rank !== 0) return rank;
      const aKnown = a.liveStatus === "LIVE" && validPopularity(a.popularity);
      const bKnown = b.liveStatus === "LIVE" && validPopularity(b.popularity);
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return aKnown && bKnown ? b.popularity! - a.popularity! : 0;
    });
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.name === "其他" || b.name === "其他") return a.name === b.name ? 0 : a.name === "其他" ? 1 : -1;
    return b.liveCount - a.liveCount || (previousRanks.get(a.key) ?? previousOrder.length) - (previousRanks.get(b.key) ?? previousOrder.length);
  });
}
