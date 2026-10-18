"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, m, useMotionValue, useSpring } from "framer-motion";
import { Check, ListCollapse, RotateCw, Users, X } from "lucide-react";
import { createPortal } from "react-dom";

import styles from "./FollowsList.module.css";
import { Platform as PlatformEnum } from "@/platforms/common/types";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { buildFollowGameGroups } from "@/state/follow/followGrouping";
import { useAppSettings } from "@/state/settings/SettingsProvider";
import { useImageProxy } from "@/hooks/useImageProxy";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";

// 参考 dart_simple_live 的 follow_service.dart：按 CPU 核心数自动分配 4–20 个查询。
const FOLLOW_REFRESH_CONCURRENCY = () => Math.min(20, Math.max(4,
  Math.round((typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2) * 2.5)));
type FollowStatusFilter = "ALL" | "LIVE" | "OFFLINE";
const REFRESH_INITIAL_DELAY_MS = 1500;

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
    patch.popularity = typeof info?.popularity === "number" && Number.isFinite(info.popularity) && info.popularity >= 0 ? info.popularity : undefined;
  }
  return patch;
}

async function refreshOne(streamer: FollowedStreamer) {
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
    try {
      const info = await invokeWithTimeout<any>("get_huya_unified_cmd", { roomId: streamer.id, quality: null, line: null, metadataOnly: true });
      return {
        nickname: info?.nick ?? streamer.nickname,
        avatarUrl: info?.avatar ?? streamer.avatarUrl,
        roomTitle: info?.title ?? streamer.roomTitle,
        liveStatus: normalizeLiveStatus(info?.is_live),
        ...categoryMetadataPatch(info, normalizeLiveStatus(info?.is_live))
      } satisfies Partial<FollowedStreamer>;
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "";
      if (msg.includes("主播未开播或获取虎牙房间详情失败")) {
        return { liveStatus: "OFFLINE" } satisfies Partial<FollowedStreamer>;
      }
      throw e;
    }
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
      if (metadata.categoryName) return metadata;
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

export function FollowsList() {
  const pathname = usePathname();
  const follow = useFollow();
  const { settings } = useAppSettings();
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();
  const playerOverlay = usePlayerOverlay();

  const listRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const expandBtnRef = useRef<HTMLButtonElement | null>(null);

  const hoverOpacity = useMotionValue(0);
  const hoverYRaw = useMotionValue(0);
  const hoverHRaw = useMotionValue(38);
  const hoverY = useSpring(hoverYRaw, { stiffness: 520, damping: 44, mass: 0.7 });
  const hoverH = useSpring(hoverHRaw, { stiffness: 520, damping: 44, mass: 0.7 });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [showCheckIcon, setShowCheckIcon] = useState(false);
  const [isMac, setIsMac] = useState(false);

  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayAlignLeft, setOverlayAlignLeft] = useState(240);
  const [overlayDeleteMode, setOverlayDeleteMode] = useState(false);
  const { platformFilter: overlayFilter, setPlatformFilter: setOverlayFilter, statusFilter, setStatusFilter } = follow;
  const categoryOrderRef = useRef<string[]>([]);
  const overlayAnchorCenterXRef = useRef<number | null>(null);
  const overlayPanelRef = useRef<HTMLDivElement | null>(null);
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  const allStreamers = follow.followedStreamers;

  useEffect(() => {
    if (allStreamers.some((s) => (s.platform === "BILIBILI" || s.platform === "HUYA") && !!s.avatarUrl)) {
      void ensureProxyStarted();
    }
  }, [allStreamers, ensureProxyStarted]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const platform = String(p).toLowerCase();
        setIsMac(platform === "macos" || platform === "darwin");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 仅在“本次启动首次进入软件”时：延迟 + idle 自动刷新一次；后续只能手动刷新
  useEffect(() => {
    if (!follow.hydrated) return;
    if (allStreamers.length === 0) return;
    // 等待关注数据就绪后再消耗一次性标记，避免 hydrated 先到导致错过自动刷新
    if (!follow.consumeInitialAutoRefresh()) return;
    const hasBiliOrHuya = allStreamers.some((s) => s.platform === "BILIBILI" || s.platform === "HUYA");

    let cancelled = false;
    const requestIdle = (cb: () => void, timeout = REFRESH_INITIAL_DELAY_MS) => {
      const ric = (window as any).requestIdleCallback as ((fn: () => void, opts?: { timeout: number }) => number) | undefined;
      if (typeof ric === "function") {
        const id = ric(() => cb(), { timeout });
        return () => (window as any).cancelIdleCallback?.(id);
      }
      const t = window.setTimeout(cb, timeout);
      return () => window.clearTimeout(t);
    };

    const cancelIdle = requestIdle(() => {
      if (cancelled) return;
      if (hasBiliOrHuya) void ensureProxyStarted();
      void refreshListRef.current?.();
    }, REFRESH_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      cancelIdle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStreamers.length, follow.hydrated]);

  const onItemEnter = useCallback((el: HTMLElement) => {
    const root = listRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hoverYRaw.set(r.top - rr.top + root.scrollTop);
    hoverHRaw.set(r.height);
    hoverOpacity.set(1);
  }, [hoverHRaw, hoverOpacity, hoverYRaw]);

  // 刷新互斥锁用 ref 而非 state：state 在 useCallback 闭包里会陈旧，
  // 导致定时轮询调用到旧的 isRefreshing 值而误判/死锁。
  const isRefreshingRef = useRef(false);
  // 组件是否仍挂载：卸载后不再 setState
  const aliveRef = useRef(true);

  const refreshList = useCallback(async () => {
    if (isRefreshingRef.current) return;
    // 只发现新增开播：已确认 LIVE 的关注不再查询，也不改写其缓存。
    // 使用完整关注库而非当前可见列表，才能找到被“直播中”筛选隐藏的主播。
    const streamers = follow.followedStreamers.filter((streamer) => streamer.liveStatus !== "LIVE");
    if (streamers.length === 0) return;
    const queue = interleaveByPlatform(streamers);
    const concurrency = FOLLOW_REFRESH_CONCURRENCY();
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
    let patchTimer: number | null = null;
    const pendingPatches: Array<{ platform: FollowedStreamer["platform"]; id: string; patch: Partial<FollowedStreamer> }> = [];
    const flushPatches = () => {
      if (patchTimer !== null) window.clearTimeout(patchTimer);
      patchTimer = null;
      if (isCurrent() && pendingPatches.length) follow.updateStreamers(pendingPatches.splice(0));
    };

    try {
      let idx = 0;
      // 每 100ms 批量写回已完成结果，不等待慢房间，也避免每条结果触发一次重渲染。
      const workers = Array.from({ length: Math.min(concurrency, streamers.length) }, async () => {
        while (isCurrent() && idx < queue.length) {
          const current = queue[idx];
          idx += 1;
          try {
            const patch = await refreshOne(current);
            if (!isCurrent()) return;
            pendingPatches.push({ platform: current.platform, id: current.id, patch });
            if (patchTimer === null) patchTimer = window.setTimeout(flushPatches, 100);
          } catch {
            // 刷新失败时保持原状态不动：之前把 LIVE 降级为 UNKNOWN 会导致网络抖动时
            // 状态在绿/灰之间乱跳（用户感知为"状态没同步/不同步"）。
            void 0;
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
      if (patchTimer !== null) window.clearTimeout(patchTimer);
      if (!expired) releaseLock();
      if (isCurrent()) {
        setIsRefreshing(false);
        setShowCheckIcon(true);
        window.setTimeout(() => { if (aliveRef.current) setShowCheckIcon(false); }, 1000);
      }
    }
  }, [follow]);

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

  // 定时轮询：setTimeout 链（同一时刻最多一个挂起定时器，不堆积）；
  // 复用 refreshList 的并发查询和批量更新。
  // 注意：不能依赖 document.visibilityState 判断——Tauri 窗口未聚焦/被遮挡时
  // WebView2 会把它报成 "hidden"，会导致轮询整轮被跳过（表现为"轮询没生效"）。
  // 这里只检查窗口是否真的被隐藏（minimize），窗口存在就照常刷新。
  const pollIntervalMs = Math.max(0, settings.followPollIntervalMin) * 60_000;
  useEffect(() => {
    if (pollIntervalMs <= 0) return;
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
  }, [pollIntervalMs, allStreamers.length]);

  const openOverlay = useCallback(() => {
    const btnRect = expandBtnRef.current?.getBoundingClientRect();
    const centerX = btnRect ? btnRect.left + btnRect.width / 2 : null;
    overlayAnchorCenterXRef.current = centerX;

    // Set an initial left; re-center precisely after panel is mounted/measured.
    const estimatedPanelWidth = 820;
    const requestedLeft = centerX != null ? Math.round(centerX - estimatedPanelWidth / 2) : 240;
    const fallbackMaxLeft = typeof window !== "undefined" ? Math.max(16, window.innerWidth - estimatedPanelWidth - 16) : requestedLeft;
    setOverlayAlignLeft(Math.max(16, Math.min(requestedLeft, fallbackMaxLeft)));
    setOverlayDeleteMode(false);
    setOverlayOpen(true);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlayOpen(false);
    setOverlayDeleteMode(false);
  }, []);

  useEffect(() => {
    if (!overlayOpen) return;
    // Re-clamp left based on real panel width (align with old project behavior)
    const panelWidth = overlayPanelRef.current?.getBoundingClientRect().width ?? 0;
    if (typeof window !== "undefined" && panelWidth > 0) {
      const maxLeft = Math.max(16, window.innerWidth - panelWidth - 16);
      const centerX = overlayAnchorCenterXRef.current;
      const desired = centerX != null ? Math.round(centerX - panelWidth / 2) : null;
      setOverlayAlignLeft((v) => Math.max(16, Math.min(desired ?? v, maxLeft)));
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOverlay, overlayOpen]);

  const handleStreamerClick = useCallback(
    (platform: FollowPlatform, id: string) => {
      playerOverlay.openPlayer({ platform: platform.toLowerCase(), roomId: id });
    },
    [playerOverlay]
  );

  const overlayPlatforms = useMemo(() => {
    const present = new Set<FollowPlatform>();
    for (const s of allStreamers) present.add(s.platform);
    const order: FollowPlatform[] = ["DOUYU", "HUYA", "DOUYIN", "BILIBILI", "TWITCH"];
    return order.filter((p) => present.has(p));
  }, [allStreamers]);

  const gameGroups = useMemo(() => buildFollowGameGroups(allStreamers, overlayFilter, statusFilter, undefined, categoryOrderRef.current), [allStreamers, overlayFilter, statusFilter]);
  useEffect(() => {
    if (gameGroups.length) categoryOrderRef.current = [...gameGroups.map((g) => g.key), ...categoryOrderRef.current.filter((key) => !gameGroups.some((g) => g.key === key))];
  }, [gameGroups]);

  const platformLabel = useCallback((p: "ALL" | FollowPlatform) => {
    if (p === "ALL") return "全部";
    if (p === "DOUYU") return "斗鱼";
    if (p === "HUYA") return "虎牙";
    if (p === "DOUYIN") return "抖音";
    if (p === "BILIBILI") return "B站";
    if (p === "TWITCH") return "Twitch";
    return p;
  }, []);

  const renderStreamerRow = (s: FollowedStreamer, itemKey: string) => {
    const liveDotClass = s.liveStatus === "LIVE" ? styles.liveDotLive : s.liveStatus === "UNKNOWN" ? styles.liveDotUnknown : styles.liveDotOffline;
    const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
    return (
      <div
        key={itemKey}
        className={styles.listItemWrapper}
        onMouseEnter={(e) => onItemEnter(e.currentTarget)}
      >
        <div
          className={styles.streamerItem}
          role="button"
          tabIndex={0}
          onClick={() => handleStreamerClick(s.platform, s.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleStreamerClick(s.platform, s.id); } }}
        >
          <span className={styles.avatarWrap} aria-hidden="true">
            <span className={styles.avatar}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {avatarSrc ? (
                <img className={styles.avatarImg} src={avatarSrc} alt={s.nickname} loading="lazy" decoding="async" draggable={false} />
              ) : (
                <span className={styles.avatarFallback}>{(s.nickname || "?").slice(0, 1)}</span>
              )}
            </span>
            <span className={`${styles.liveDot} ${styles.liveDotOnAvatar} ${liveDotClass}`} aria-hidden="true" />
          </span>
          <div className={styles.meta}>
            <div className={styles.name} title={s.nickname}>
              {s.nickname}
            </div>
            <div className={styles.sub} title={s.roomTitle || ""}>
              {s.roomTitle || "暂无直播标题"}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderOverlayCard = (s: FollowedStreamer) => {
                        const avatarSrc = getAvatarSrc(s.platform, s.avatarUrl);
                        const liveDotClass = s.liveStatus === "LIVE" ? styles.liveDotLive : s.liveStatus === "UNKNOWN" ? styles.liveDotUnknown : styles.liveDotOffline;
                        const liveText = s.liveStatus === "LIVE" ? "直播中" : s.liveStatus === "OFFLINE" ? "离线" : "未知";
                        const roomTitle = s.roomTitle || "暂无直播标题";
                        return (
                          <div
                            key={`${s.platform}:${s.id}`}
                            className={`${styles.followOverlayCard} ${overlayDeleteMode ? styles.followOverlayCardManage : ""}`}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (overlayDeleteMode) return;
                              playerOverlay.openPlayer({ platform: s.platform.toLowerCase(), roomId: s.id });
                              closeOverlay();
                            }}
                          >
                            {overlayDeleteMode ? (
                              <button
                                type="button"
                                className={styles.followOverlayRemoveBtn}
                                title="删除"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  follow.unfollowStreamer(s.platform, s.id);
                                }}
                              >
                                ×
                              </button>
                            ) : null}
                            <div className={styles.followOverlayCardTop}>
                              <div className={styles.resultAvatar}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {avatarSrc ? <img className={styles.resultAvatarImg} src={avatarSrc} alt={s.nickname} /> : <div className={styles.resultAvatarFallback}>{(s.nickname || "?").slice(0, 1)}</div>}
                                <span className={`${styles.liveDot} ${styles.liveDotOnAvatar} ${liveDotClass}`} aria-hidden="true" />
                              </div>
                              <div className={styles.resultMain}>
                                <div className={styles.resultName} title={s.nickname}>
                                  {s.nickname}
                                </div>
                              <div className={styles.resultTitle} title={`${platformLabel(s.platform)} · ${liveText} · ${roomTitle}`}>
                                {platformLabel(s.platform)} · {liveText} · {roomTitle}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
  };

  const renderViewControls = (compact: boolean) => (
    <div className={compact ? styles.sidebarFilters : styles.viewFilters}>
      <div className={styles.followFilterSelects}>
        <select aria-label="关注平台筛选" value={overlayFilter} onChange={(e) => setOverlayFilter(e.target.value as "ALL" | FollowPlatform)}>
          <option value="ALL">全部平台</option>
          {overlayPlatforms.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
        </select>
        <select aria-label="关注直播状态筛选" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as FollowStatusFilter)}>
          <option value="ALL">全部状态</option><option value="LIVE">直播中</option><option value="OFFLINE">未开播</option>
        </select>
      </div>
    </div>
  );

  return (
    <div className={styles.followList}>
      <div className={styles.listHeader} ref={headerRef} data-tauri-drag-region>
        <div className={styles.headerLeft} data-tauri-drag-region>
          {!isMac ? (
            <span className={`${styles.actionBtn} ${styles.headerStaticIcon}`} aria-hidden="true">
              <Users size={18} />
            </span>
          ) : null}
          <h3 className={styles.headerTitle} aria-label="关注列表" data-tauri-drag-region>
            <span className={styles.headerLabel} data-tauri-drag-region />
          </h3>
        </div>
        <div className={styles.headerActions} data-tauri-drag-region="false">
          {!isRefreshing ? (
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.refreshBtn}`}
              data-tauri-drag-region="false"
              title="刷新列表"
              onClick={() => void refreshList()}
            >
              {showCheckIcon ? <Check size={18} /> : <RotateCw size={18} />}
            </button>
          ) : (
            <span className={styles.progressWithSpinner} aria-live="polite">
              <span className={styles.spinner} aria-hidden="true" />
              <span>
                {progressCurrent}/{progressTotal}
              </span>
            </span>
          )}

          <button
            type="button"
            className={`${styles.actionBtn} ${styles.expandBtn}`}
            data-tauri-drag-region="false"
            title="展开关注列表"
            ref={expandBtnRef}
            onClick={openOverlay}
          >
            <ListCollapse size={18} />
          </button>
        </div>
      </div>

      {renderViewControls(true)}

      <div
        className={styles.listContent}
        ref={listRef}
        onScroll={() => hoverOpacity.set(0)}
        onMouseLeave={() => hoverOpacity.set(0)}
      >
        <m.div
          className={styles.hoverHighlight}
          style={{ opacity: hoverOpacity, y: hoverY, height: hoverH }}
        />

        <div className={styles.streamersList}>
          {gameGroups.length ? gameGroups.map((group) => (
            <section key={group.key} className={styles.gameGroup} data-follow-category={group.name}>
              <h4 className={styles.gameGroupTitle}>{group.name}<span>{group.members.length}人</span></h4>
              {group.members.map((streamer) => renderStreamerRow(streamer, `${streamer.platform}:${streamer.id}`))}
            </section>
          )) : <div className={styles.sidebarEmpty}>当前筛选下暂无关注主播</div>}
        </div>
      </div>

      {portalTarget
        ? createPortal(
            <AnimatePresence>
              {overlayOpen ? (
                <m.div
                  className={styles.overlayBackdrop}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) closeOverlay();
                  }}
                >
                  <div className={styles.followOverlayAnchor}>
                    <m.div
                      className={styles.followOverlayPanel}
                      ref={overlayPanelRef}
                      initial={{ opacity: 0, scale: 0.96, y: 16 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96, y: 16 }}
                      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                <button type="button" className={styles.followOverlayCloseBtn} title="关闭" onClick={closeOverlay}>
                  <X size={18} />
                </button>

                <div className={styles.followOverlayHeader}>
                  <div className={styles.followOverlayFilters}>
                    <button
                      type="button"
                      className={`${styles.filterChip} ${overlayFilter === "ALL" ? styles.filterChipActive : ""}`}
                      onClick={() => setOverlayFilter("ALL")}
                    >
                      {platformLabel("ALL")}
                    </button>
                    {overlayPlatforms.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`${styles.filterChip} ${overlayFilter === p ? styles.filterChipActive : ""}`}
                        onClick={() => setOverlayFilter(p)}
                      >
                        {platformLabel(p)}
                      </button>
                    ))}
                  </div>
                  <div className={styles.followOverlayActions}>
                    <button
                      type="button"
                      className={`${styles.overlayTextBtn} ${overlayDeleteMode ? styles.overlayTextBtnActive : ""}`}
                      onClick={() => setOverlayDeleteMode((v) => !v)}
                    >
                      {overlayDeleteMode ? "完成" : "管理"}
                    </button>
                    <button
                      type="button"
                      className={`${styles.overlayTextBtn} ${isRefreshing ? styles.overlayTextBtnRefreshing : ""}`}
                      disabled={isRefreshing}
                      onClick={() => void refreshList()}
                    >
                      <span>刷新</span>
                      <span className={styles.overlaySpinner} aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {renderViewControls(false)}

                <div className={styles.followOverlayContent}>
                  {gameGroups.length > 0 ? (
                    gameGroups.map((group) => (
                      <section key={group.key} className={styles.gameGroup} data-follow-category={group.name}>
                        <h4 className={styles.gameGroupTitle}>{group.name}<span>{group.members.length}人</span></h4>
                        <div className={styles.followOverlayGrid}>{group.members.map(renderOverlayCard)}</div>
                      </section>
                    ))
                  ) : (
                    <div className={styles.followOverlayEmpty}>
                      <div className={styles.emptyTitle}>暂无关注主播</div>
                      <div className={styles.emptyText}>当前筛选下暂无关注主播</div>
                    </div>
                  )}
                </div>
                    </m.div>
                  </div>
                </m.div>
              ) : null}
            </AnimatePresence>,
            portalTarget
          )
        : null}
    </div>
  );
}
