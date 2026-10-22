"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Platform as PlatformEnum } from "@/platforms/common/types";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "./FollowProvider";
import { useAppSettings } from "@/state/settings/SettingsProvider";

type FollowRefreshValue = {
  isRefreshing: boolean;
  progressCurrent: number;
  progressTotal: number;
  showCheckIcon: boolean;
  refreshList: () => Promise<void>;
};
const FollowRefreshContext = createContext<FollowRefreshValue | null>(null);

// 参考 dart_simple_live 的 follow_service.dart：按 CPU 核心数自动分配 4–20 个查询。
const FOLLOW_REFRESH_CONCURRENCY = (configured = 0) => {
  if (Number.isInteger(configured) && configured > 0 && configured <= 20) return configured;
  return Math.min(20, Math.max(4,
    Math.round((typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2) * 2.5)));
};

// 单个主播状态查询的超时上限。
// 与 MainPlayer 的 invokeWithTimeout 同一个道理：Rust 侧就算某个请求没设 timeout 而永久挂住，
// 这里也必须自己兜住，否则 await 永不返回 → refreshList 的 finally 永远走不到 →
// isRefreshingRef 永久为 true → 之后自动刷新和手动刷新全被挡下（表现为「自动刷新失效」）。
const REFRESH_ONE_TIMEOUT_MS = 20_000;

function invokeWithTimeout<T>(cmd: string, args?: Record<string, unknown>, timeoutMs = REFRESH_ONE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${cmd} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    invoke<T>(cmd, args)
      .then((v) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(e);
      });
  });
}

function normalizeLiveStatus(isLive: boolean | null | undefined): FollowedStreamer["liveStatus"] {
  if (isLive === true) return "LIVE";
  if (isLive === false) return "OFFLINE";
  return "UNKNOWN";
}

// 分类只来自官方元数据；与直播状态解耦（斗鱼 betard / B站 room_info / 虎牙 profileRoom
// 在主播未开播时同样返回分类，真实响应已验证），不用空值/“其他”覆盖缓存，热度不持久化。
function categoryMetadataPatch(info: any, status: FollowedStreamer["liveStatus"]): Partial<FollowedStreamer> {
  const patch: Partial<FollowedStreamer> = {};
  const name = typeof info?.category_name === "string" ? info.category_name.trim() : "";
  const meaningful = name.replace(/\s*专区$/, "").trim().toLowerCase();
  if (meaningful && !["null", "undefined", "0", "未知", "未分类", "其他"].includes(meaningful)) {
    patch.categoryName = name;
    const id = info?.category_id;
    if (id != null && String(id).trim() && String(id) !== "0") patch.categoryId = String(id);
  }
  // 热度仍是纯运行时数据：开播时记录，未开播清除过期值，UNKNOWN 不动。
  if (status === "OFFLINE") patch.popularity = undefined;
  else if (status === "LIVE") {
    patch.popularity = typeof info?.popularity === "number" && Number.isFinite(info.popularity) && info.popularity > 0 ? info.popularity : undefined;
  }
  return patch;
}

async function refreshOne(streamer: FollowedStreamer): Promise<Partial<FollowedStreamer>> {
  if (streamer.platform === "DOUYU") {
    const info = await invokeWithTimeout<any>("fetch_douyu_room_info", { roomId: streamer.id });
    const showStatus = info?.show_status == null ? NaN : Number(info.show_status);
    const rawVideoLoop = info?.video_loop ?? info?.videoLoop ?? null;
    const videoLoop =
      typeof rawVideoLoop === "number" ? rawVideoLoop : rawVideoLoop === null || typeof rawVideoLoop === "undefined" ? null : Number(rawVideoLoop);

    // Douyu: show_status === 1 即开播；仅在明确 video_loop === 1（轮播/回放）时视为未开播。
    // 注意：该接口常常不返回 video_loop，若把"取不到"也算未开播/未知，会导致
    // 正在直播的主播被误判成灰色/未知（这正是状态不同步的主要原因）。
    let liveStatus: FollowedStreamer["liveStatus"] = Number.isFinite(showStatus) ? "OFFLINE" : "UNKNOWN";
    if (showStatus === 1) {
      liveStatus = videoLoop === 1 ? "OFFLINE" : "LIVE";
    }
    return {
      nickname: info?.nickname ?? streamer.nickname,
      avatarUrl: info?.avatar_url ?? streamer.avatarUrl,
      roomTitle: info?.room_name ?? info?.roomName ?? streamer.roomTitle,
      liveStatus,
      ...categoryMetadataPatch(info, liveStatus)
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "HUYA") {
    const info = await invokeWithTimeout<any>("get_huya_unified_cmd", { roomId: streamer.id, quality: null, line: null, metadataOnly: true });
    const liveStatus = normalizeLiveStatus(info?.is_live);
    return {
      nickname: info?.nick ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus,
      ...categoryMetadataPatch(info, liveStatus)
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "BILIBILI") {
    const payload = { platform: PlatformEnum.BILIBILI, args: { room_id_str: streamer.id } };
    const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") || null : null;
    const info = await invokeWithTimeout<any>("fetch_bilibili_streamer_info", { payload, cookie });
    const status = info?.status == null ? NaN : Number(info.status);
    const live = status === 1 ? true : status === 0 || status === 2 ? false : null;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live),
      ...categoryMetadataPatch(info, normalizeLiveStatus(live))
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "DOUYIN") {
    const payload = { platform: PlatformEnum.DOUYIN, args: { room_id_str: streamer.id } };
    const info = await invokeWithTimeout<any>("fetch_douyin_streamer_info", { payload });
    const status = Number(info?.status);
    if (info?.error_message || info?.status == null || (status !== 2 && status !== 4)) {
      // 状态与分类独立：保留已经拿到的官方分类，但不把未知状态写成离线。
      const metadata = categoryMetadataPatch(info, "UNKNOWN");
      if (metadata.categoryName) return { ...metadata, liveStatus: "UNKNOWN", popularity: undefined } satisfies Partial<FollowedStreamer>;
      throw new Error(info?.error_message || "抖音直播状态暂时无法确认");
    }
    // Douyin: status === 2 means live (align with player/follow helpers)
    const live = status === 2;
    return {
      nickname: info?.anchor_name ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(live),
      ...categoryMetadataPatch(info, normalizeLiveStatus(live))
    } satisfies Partial<FollowedStreamer>;
  }

  if (streamer.platform === "TWITCH") {
    // Twitch 关注的 id 即频道 login；轻量 GQL 快照，未开播也不报错
    const info = await invokeWithTimeout<any>("get_twitch_streamer_status", { login: streamer.id });
    return {
      nickname: info?.nickname ?? streamer.nickname,
      avatarUrl: info?.avatar ?? streamer.avatarUrl,
      roomTitle: info?.title ?? streamer.roomTitle,
      liveStatus: normalizeLiveStatus(info?.is_live),
      ...categoryMetadataPatch(info, normalizeLiveStatus(info?.is_live))
    } satisfies Partial<FollowedStreamer>;
  }

  return {} satisfies Partial<FollowedStreamer>;
}

// 平台交错查询，避免列表开头的同一平台占满所有工作线程；保留平台内顺序。
function interleaveByPlatform(streamers: FollowedStreamer[]) {
  const groups = new Map<FollowPlatform, FollowedStreamer[]>();
  for (const streamer of streamers) {
    const group = groups.get(streamer.platform) ?? [];
    group.push(streamer);
    groups.set(streamer.platform, group);
  }
  const queue: FollowedStreamer[] = [];
  for (let index = 0; queue.length < streamers.length; index++) {
    for (const group of groups.values()) if (index < group.length) queue.push(group[index]);
  }
  return queue;
}

export function FollowRefreshProvider({ children }: { children: React.ReactNode }) {
  const follow = useFollow();
  const { settings, hydrated: settingsHydrated } = useAppSettings();
  const allStreamers = follow.followedStreamers;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [showCheckIcon, setShowCheckIcon] = useState(false);

  // 刷新互斥锁用 ref 而非 state：state 在 useCallback 闭包里会陈旧，
  // 导致定时轮询调用到旧的 isRefreshing 值而误判/死锁。
  const isRefreshingRef = useRef(false);
  // 组件是否仍挂载：卸载后不再 setState
  const aliveRef = useRef(true);

  const refreshList = useCallback(async () => {
    if (isRefreshingRef.current) return;
    // LIVE 只是上次查询结果，可能来自昨天的持久化缓存，必须重新校验才能发现下播。
    // 首次、手动与定时刷新共用完整关注库；只查元数据，不受当前筛选影响。
    const streamers = follow.followedStreamers;
    if (streamers.length === 0) return;
    const queue = interleaveByPlatform(streamers);
    const concurrency = FOLLOW_REFRESH_CONCURRENCY(settings.followRefreshConcurrency);
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setShowCheckIcon(false);
    setProgressTotal(streamers.length);
    setProgressCurrent(0);

    // 总闸：refreshList 内部任何一处抛异常/永不返回，都必须把互斥锁放开。
    // 锁一旦漏在这里，isRefreshingRef 永久为 true，之后自动刷新和手动刷新都会被
    // 开头那行「if (isRefreshingRef.current) return;」无声挡下——
    // 表现就是「自动刷新好像失效了，点刷新也没反应」。
    // （与 v0.2.5 修的播放器 reloadInFlightRef 泄漏是同一类问题）
    // 上限按本轮实际主播数和并发数推算，再留 15s 余量。
    const totalCap = Math.ceil(streamers.length / concurrency) * REFRESH_ONE_TIMEOUT_MS + 15_000;
    let expired = false;
    const isCurrent = () => aliveRef.current && !expired;
    const releaseLock = () => {
      isRefreshingRef.current = false;
    };
    const watchdog = window.setTimeout(() => {
      expired = true;
      releaseLock();
      if (aliveRef.current) setIsRefreshing(false);
    }, totalCap);
    const pendingPatches: Array<{ platform: FollowedStreamer["platform"]; id: string; patch: Partial<FollowedStreamer> }> = [];
    const flushPatches = () => {
      if (isCurrent() && pendingPatches.length) follow.updateStreamers(pendingPatches.splice(0));
    };

    try {
      let idx = 0;
      // 参考 FollowService.updateLiveStatus：新开播或分类变更立即发布，其余在整轮结束合并发布。
      const workers = Array.from({ length: Math.min(concurrency, streamers.length) }, async () => {
        while (isCurrent() && idx < queue.length) {
          const current = queue[idx];
          idx += 1;
          try {
            const patch = await refreshOne(current);
            if (!isCurrent()) return;
            pendingPatches.push({ platform: current.platform, id: current.id, patch });
            if ((current.liveStatus !== "LIVE" && patch.liveStatus === "LIVE") ||
                (patch.categoryName && patch.categoryName !== current.categoryName)) flushPatches();
          } catch {
            // Simple Live 的 0 状态对应 UNKNOWN：请求失败不继续冒充旧的 LIVE，也不伪装下播。
            if (isCurrent()) pendingPatches.push({ platform: current.platform, id: current.id,
              patch: { liveStatus: "UNKNOWN", popularity: undefined } });
          } finally {
            if (isCurrent()) setProgressCurrent((v) => v + 1);
          }
        }
      });
      await Promise.all(workers);

      flushPatches();
      // 游戏分组只是视图，刷新不写回列表顺序。
    } finally {
      window.clearTimeout(watchdog);
      if (!expired) releaseLock();
      if (isCurrent()) {
        setIsRefreshing(false);
        setShowCheckIcon(true);
        window.setTimeout(() => { if (aliveRef.current) setShowCheckIcon(false); }, 1000);
      }
    }
  }, [follow, settings.followRefreshConcurrency]);

  // 组件卸载时：释放锁 + 停止后续 setState
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      isRefreshingRef.current = false;
    };
  }, []);

  // 轮询始终调用最新版 refreshList，避免闭包里 isRefreshing 陈旧导致并发刷新
  const refreshListRef = useRef(refreshList);
  useEffect(() => {
    refreshListRef.current = refreshList;
  }, [refreshList]);

  // 对应 Simple Live 的全局 FollowService Timer：不依赖侧栏、路由或全屏状态。
  // setTimeout 保持固定间隔触发；刷新互斥保证慢轮次不会重复占用网络。
  const pollIntervalMs = Math.max(0, settings.followPollIntervalMin) * 60_000;
  useEffect(() => {
    if (!settingsHydrated || pollIntervalMs <= 0) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = () => {
      if (cancelled) return;
      void refreshListRef.current?.();
      timer = window.setTimeout(tick, pollIntervalMs);
    };
    timer = window.setTimeout(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pollIntervalMs, settingsHydrated]);

  // 与 Simple Live loadData 一样，数据就绪就校验，不等待 UI idle。
  useEffect(() => {
    if (!follow.hydrated || !settingsHydrated || allStreamers.length === 0) return;
    if (!follow.consumeInitialAutoRefresh()) return;
    void refreshListRef.current?.();
  }, [follow.hydrated, settingsHydrated, allStreamers.length]);

  const value = useMemo(() => ({ isRefreshing, progressCurrent, progressTotal, showCheckIcon, refreshList }),
    [isRefreshing, progressCurrent, progressTotal, showCheckIcon, refreshList]);
  return <FollowRefreshContext.Provider value={value}>{children}</FollowRefreshContext.Provider>;
}

export function useFollowRefresh() {
  const value = useContext(FollowRefreshContext);
  if (!value) throw new Error("useFollowRefresh must be used within FollowRefreshProvider");
  return value;
}
