"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m, useMotionValue, useSpring } from "framer-motion";
import { Check, ListCollapse, RotateCw, Users, X } from "lucide-react";
import { createPortal } from "react-dom";

import styles from "./FollowsList.module.css";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { buildFollowGameGroups } from "@/state/follow/followGrouping";
import { useFollowRefresh } from "@/state/follow/FollowRefreshProvider";
import { useImageProxy } from "@/hooks/useImageProxy";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";

type FollowStatusFilter = "ALL" | "LIVE" | "OFFLINE";

export function FollowsList() {
  const follow = useFollow();
  const { isRefreshing, progressCurrent, progressTotal, showCheckIcon, refreshList } = useFollowRefresh();
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

  const onItemEnter = useCallback((el: HTMLElement) => {
    const root = listRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hoverYRaw.set(r.top - rr.top + root.scrollTop);
    hoverHRaw.set(r.height);
    hoverOpacity.set(1);
  }, [hoverHRaw, hoverOpacity, hoverYRaw]);

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
