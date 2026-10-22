import Player from "xgplayer";
import "xgplayer/dist/index.min.css";
import "../../web/src/components/player/player.css";
import settingsStyles from "../../web/src/components/settings/SettingsModal.module.css";
import navbarStyles from "../../web/src/components/shell/Navbar.module.css";
import shellStyles from "../../web/src/components/shell/AppShell.module.css";
import overlayStyles from "../../web/src/state/playerOverlay/PlayerOverlayProvider.module.css";
import { invoke } from "@tauri-apps/api/core";
import { createNativePlayback } from "../../web/src/components/player/nativePlayback";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
const state = () => invoke<any>("native_player_snapshot");
async function until(test: (s: any) => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (true) { const s = await state(); if (test(s)) return s; assert(Date.now() < deadline, `${message}: ${JSON.stringify(s)}`); await sleep(40); }
}
async function main() {
  let bridge: Awaited<ReturnType<typeof createNativePlayback>> | undefined;
  let player: any;
  try {
    // Keep the real mounted room list and backdrop as siblings, as AppShell does.
    const shell = document.createElement("div"); shell.className = shellStyles.appMain;
    const navbar = document.createElement("nav"); navbar.className = [navbarStyles.navbar, navbarStyles.navbarPlayer].filter(Boolean).join(" ");
    const actions = document.createElement("div"); actions.className = navbarStyles.actions;
    const captionButton = document.createElement("button"); captionButton.className = navbarStyles.winBtn; captionButton.textContent = "窗口操作";
    actions.append(captionButton); navbar.append(actions);
    const rooms = document.createElement("main"); rooms.className = shellStyles.appBody;
    rooms.innerHTML = '<article style="background:#cf143b;padding:50px">不应叠在视频上的房间卡片</article><input value="preserved room filter">';
    const overlay = document.createElement("div"); overlay.className = overlayStyles.overlayRoot;
    const backdrop = document.createElement("button"); backdrop.className = overlayStyles.backdrop;
    const panel = document.createElement("div"); panel.className = overlayStyles.overlayPanel;
    const stage = document.getElementById("stage")!;
    let content: HTMLElement = stage;
    for (const name of ["video-container", "player-container player-container--solo", "main-content", "player-layout", "player-page"]) {
      const ancestor = document.createElement("div"); ancestor.className = name; ancestor.append(content); content = ancestor;
    }
    const page = content;
    panel.append(page); overlay.append(backdrop, panel); shell.append(navbar, rooms, overlay); document.body.append(shell);
    assert(getComputedStyle(rooms).visibility === "visible", "room list hidden before native playback");
    assert(getComputedStyle(backdrop).visibility === "visible", "non-native backdrop changed");
    const verifyIsolation = () => {
      assert(getComputedStyle(rooms).visibility === "hidden", "mounted room cards overlap native video");
      assert(getComputedStyle(backdrop).visibility === "hidden", "modal backdrop tints native video");
      const r = player.root.getBoundingClientRect();
      const painted = document.elementsFromPoint(r.x+r.width/2,r.y+r.height/2);
      assert(!painted.some(el => el === rooms || rooms.contains(el) || el === backdrop), "underlying route intercepts video");
      assert(getComputedStyle(danmu).visibility === "visible", "player danmu was hidden with route");
      assert((rooms.querySelector("input") as HTMLInputElement).value === "preserved room filter", "room state was remounted/reset");
    };
    const media = await invoke<string>("smoke_media");
    bridge = await createNativePlayback("DOUYIN");
    player = new Player({ el: document.getElementById("stage"), mediaEl: bridge.video, url: media, autoplay: true, isLive: true, width: "100%", height: "100%", volume: 1 });
    bridge.attach(player);
    const danmu = document.createElement("div"); danmu.className = "danmu"; danmu.textContent = "DTV 弹幕和现有控制栏 · libmpv"; player.root.appendChild(danmu);
    await bridge.ready;
    await invoke("smoke_window", { action: "focus" });
    const initial = await until(s => s.loaded && s.surfaceVisible && s.position > 0.05, "no native first frame");
    await sleep(160);
    assert(player.video === bridge.video && bridge.video.getAttribute("src") === null, "browser still pulls stream");
    assert(bridge.video.readyState === 4 && bridge.video.videoWidth === 320, "existing controls not connected");
    assert(getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)", "opaque body hides native video");
    verifyIsolation();
    const captionRect = captionButton.getBoundingClientRect();
    assert(document.elementFromPoint(captionRect.x+captionRect.width/2,captionRect.y+captionRect.height/2) === captionButton, "application titlebar buttons are covered by player overlay");
    // Version/LAN-sync dialogs are Navbar siblings of .actions, not body portals.
    const modal = document.createElement("div"); modal.className = navbarStyles.overlayBackdrop;
    const modalClose = document.createElement("button"); modalClose.textContent = "关闭标题栏弹窗";
    modal.append(modalClose); navbar.append(modal);
    const modalRect = modalClose.getBoundingClientRect();
    assert(document.elementFromPoint(modalRect.x+modalRect.width/2,modalRect.y+modalRect.height/2) === modalClose, "titlebar dialog loses pointer interaction while playing");
    modal.remove();
    await invoke("smoke_report", { report: { stage: "single-interactive-titlebar-and-dialog", passed: true } });
    // Settings is a body portal, not a descendant of Navbar's z-index 600 stack.
    const settings = document.createElement("div"); settings.className = settingsStyles.backdrop;
    const settingsCard = document.createElement("section"); settingsCard.className = settingsStyles.card;
    settingsCard.innerHTML = '<button id="settings-tab">平台设置</button><button id="settings-switch" role="switch" aria-checked="true">开关</button><select id="settings-select"><option>原画</option><option>高清</option></select><button id="settings-close">关闭设置</button>';
    settings.append(settingsCard); document.body.append(settings);
    let settingsClicks = 0;
    settingsCard.querySelectorAll('button').forEach(button => button.addEventListener('click',()=>settingsClicks++));
    for (const id of ["settings-tab", "settings-switch", "settings-select", "settings-close"]) {
      const control = settings.querySelector('#'+id) as HTMLElement, r = control.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      assert(hit===control || control.contains(hit), "settings control blocked by player: "+id);
      if (control.tagName === 'BUTTON') hit!.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    }
    assert(settingsClicks===3, "settings actions did not receive pointer events");settings.remove();
    await invoke("smoke_report", { report: { stage: "body-settings-pointer-controls", passed: true } });

    await invoke("smoke_report", { report: { stage: "room-list-backdrop-isolation", passed: true } });
    await invoke("smoke_report", { report: { stage: "first-frame-native-controls", initial } });
    player.pause(); await until(s => s.paused, "pause failed");
    player.volume = 0.3; player.muted = true; await until(s => s.muted && Math.abs(s.volume - 0.3) < 0.001, "volume/mute failed");
    await player.play(); await until(s => !s.paused, "resume failed");
    for (const [action, visible] of [["minimize", false], ["restore", true], ["hide", false], ["show", true]] as const) {
      await invoke("smoke_window", { action });
      await until(s => s.surfaceVisible === visible, `underlay did not follow ${action}`);
    }
    // Exercise the actual xgplayer modes, not just the host window's fullscreen flag.
    player.getCssFullscreen(); await sleep(350);
    assert(getComputedStyle(page).backgroundColor === "rgba(0, 0, 0, 0)", "CSS fullscreen added an opaque ancestor over native video");
    assert(getComputedStyle(player.root).backgroundColor === "rgba(0, 0, 0, 0)", "CSS fullscreen root hides native video");
    await until(s => s.loaded && s.surfaceVisible, "CSS fullscreen lost native surface");
    player.exitCssFullscreen(); await sleep(250);
    const toggleBrowserFullscreen = async (enabled: boolean) => {
      const button = player.root.querySelector(".xgplayer-fullscreen") as HTMLElement;
      assert(button, "fullscreen control missing"); button.click();
      const deadline = Date.now()+5000;
      while ((document.fullscreenElement === player.root) !== enabled) { assert(Date.now()<deadline, "fullscreen control did not change browser mode"); await sleep(40); }
    };
    await toggleBrowserFullscreen(true);
    assert(document.fullscreenElement === player.root, "actual browser fullscreen not entered");
    await sleep(500);
    assert(getComputedStyle(player.root, "::backdrop").backgroundColor === "rgba(0, 0, 0, 0)", "browser fullscreen backdrop hides native video");
    await until(s => s.loaded && s.surfaceVisible, "browser fullscreen lost native surface");
    await toggleBrowserFullscreen(false); await sleep(300);
    assert(!document.fullscreenElement && !player.fullscreen, "actual browser fullscreen did not exit");
    verifyIsolation();
    await invoke("smoke_report", { report: { stage: "actual-player-css-and-browser-fullscreen", passed: true } });
    await invoke("smoke_window", { action: "full" }); await sleep(250);
    await invoke("smoke_window", { action: "normal" }); await sleep(250);
    await invoke("native_player_pip", { generation: initial.generation, enabled: true });
    await until(s => s.pip && s.surfaceVisible, "PiP failed"); await sleep(300);
    assert(getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)", "PiP exposed desktop through main video hole");
    await invoke("native_player_pip", { generation: initial.generation, enabled: false });
    await until(s => !s.pip && s.surfaceVisible, "PiP restore failed"); await sleep(150);
    assert(getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)", "PiP exit did not restore inline native video");
    verifyIsolation();
    await invoke("smoke_report", { report: { stage: "pause-volume-mute-window-fullscreen-pip", passed: true } });
    player.pause(); await until(s => s.paused, "old room pause failed");
    const switchStarted = Date.now();
    await player.switchURL(media, { platform: "HUYA" });
    const resumed = await until(s => s.loaded && !s.paused && s.position > 0.05, "new room inherited pause or canplay gate");
    assert(Date.now()-switchStarted < 8000, "native media handoff waited too long");
    await invoke("smoke_report", { report: { stage: "native-direct-open-resets-pause", elapsedMs: Date.now()-switchStarted, resumed } });
    const pendingPauseSwitch = player.switchURL(media, { platform: "DOUYIN" });
    player.pause();
    await pendingPauseSwitch;
    await until(s => s.loaded && s.paused, "new user pause was overwritten after media open");
    await sleep(300);
    assert((await state()).paused && bridge.video.paused, "pending switch resumed against user intent");
    await invoke("smoke_report", { report: { stage: "pending-switch-preserves-new-pause", passed: true } });
    const switches = [];
    for (let i = 0; i < 30; i++) switches.push(player.switchURL(media, { platform: i%2 ? "DOUYIN" : "BILIBILI" }));
    await Promise.all(switches);
    await bridge.ready;
    const switched = await until(s => s.loaded && s.generation > initial.generation && s.position > 0.05, "latest fast switch failed");
    assert(switched.error === null, "old event affected current media");
    await bridge.dispose();
    assert(getComputedStyle(rooms).visibility === "visible", "room list not restored on dispose");
    assert(getComputedStyle(backdrop).visibility === "visible", "backdrop not restored on dispose");
    player.destroy();
    const stopped = await until(s => !s.loaded && !s.surfaceVisible, "close left native stream visible");
    assert(getComputedStyle(document.body).backgroundColor === "rgb(18, 21, 27)", "background not restored");
    await invoke("smoke_report", { report: { stage: "fast-switch-30-dispose", passed: true, switched, stopped } });
    await invoke("smoke_report", { report: { done: true, passed: true } });
  } catch (error) {
    try { await bridge?.dispose(); player?.destroy(); } catch { /* Retain the first failure. */ }
    await invoke("smoke_report", { report: { done: true, passed: false, error: String(error) } });
  }
}
void main();
