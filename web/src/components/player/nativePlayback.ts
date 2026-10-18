import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createNativeMedia, nativeMediaHeaders, type NativeSnapshot } from "./nativeMedia";

export function usesNativePlayback(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Windows/i.test(navigator.userAgent);
}

/** Keep ancestor backgrounds everywhere except the native video rectangle. */
function revealVideo(root: HTMLElement) {
  const properties = ["background-color", "background-image", "background-size", "background-position", "background-repeat"];
  const layers: { element: HTMLElement; color: string; saved: [string, string, string][] }[] = [];
  let element: HTMLElement | null = root;
  while (element) {
    const color = getComputedStyle(element).backgroundColor;
    // Fullscreen classes can make a previously transparent ancestor opaque.
    // Own every ancestor's background for the lifetime of this native surface.
    layers.push({ element, color, saved: properties.map(p => [p, element!.style.getPropertyValue(p), element!.style.getPropertyPriority(p)]) });
    element = element.parentElement;
  }
  let active = true;
  const restore = () => {
    for (const layer of layers) {
      for (const [property, value, priority] of layer.saved) {
        if (value) layer.element.style.setProperty(property, value, priority);
        else layer.element.style.removeProperty(property);
      }
    }
  };
  const update = (refreshColors = false) => {
    if (refreshColors) { restore(); for (const layer of layers) layer.color = getComputedStyle(layer.element).backgroundColor; }
    if (!active) return;
    const hole = root.getBoundingClientRect();
    for (const { element, color } of layers) {
      const box = element.getBoundingClientRect();
      const left = Math.max(0, Math.min(box.width, hole.left - box.left));
      const right = Math.max(left, Math.min(box.width, hole.right - box.left));
      const top = Math.max(0, Math.min(box.height, hole.top - box.top));
      const bottom = Math.max(top, Math.min(box.height, hole.bottom - box.top));
      element.style.setProperty("background-color", "transparent", "important");
      element.style.setProperty("background-image", Array(4).fill(`linear-gradient(${color},${color})`).join(","), "important");
      element.style.setProperty("background-size", `${left}px 100%,${box.width - right}px 100%,${right - left}px ${top}px,${right - left}px ${box.height - bottom}px`, "important");
      element.style.setProperty("background-position", `0 0,100% 0,${left}px 0,${left}px 100%`, "important");
      element.style.setProperty("background-repeat", "no-repeat", "important");
    }
  };
  update();
  const theme = new MutationObserver(() => update(true));
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return { update: () => update(), setActive: (enabled: boolean) => { active = enabled; if (enabled) update(true); else restore(); }, restore: () => { theme.disconnect(); restore(); } };
}

export async function createNativePlayback(platform: string) {
  const video = document.createElement("video");
  video.classList.add("dtv-native-media");
  video.dataset.nativePlayback = "true";
  let pip = false;
  let setPipMask: (enabled: boolean) => void = () => {};
  const adapter = createNativeMedia(video, async (command, args) => {
    // Fill the main video hole before the native surface moves to PiP.
    if (command === "native_player_pip" && args.enabled === true) setPipMask(true);
    try { return await invoke(command, args); } catch (error) {
      if (command === "native_player_pip") setPipMask(pip);
      throw error;
    }
  }, nativeMediaHeaders(platform));
  const unlisten = await listen<NativeSnapshot>("native-player-state", event => adapter.accept(event.payload));
  const unlistenPip = await listen<{ generation: number; enabled: boolean }>("native-player-pip", event => {
    if (event.payload.generation !== adapter.generation) return;
    pip = event.payload.enabled; setPipMask(pip);
    adapter.acceptPip(event.payload.generation, pip);
  });
  let disposed = false;
  let stopGeometry: (() => void) | undefined;
  return {
    video,
    get ready() { return adapter.ready; },
    attach(player: { root: HTMLElement; on: (name: string, callback: () => void) => void }) {
      const root = player.root;
      root.classList.add("dtv-native-player");
      let backgrounds: ReturnType<typeof revealVideo> | undefined;
      setPipMask = enabled => backgrounds?.setActive(!enabled);
      let previous = "";
      const update = () => {
        if (disposed || !root.isConnected || !adapter.generation) return;
        const r = root.getBoundingClientRect(), d = window.devicePixelRatio;
        const args = { generation: adapter.generation, x: Math.round(r.x * d), y: Math.round(r.y * d), width: Math.round(r.width * d), height: Math.round(r.height * d) };
        const key = JSON.stringify(args);
        if (key === previous) return;
        previous = key;
        backgrounds?.update();
        void invoke("native_player_rect", args).catch(console.error);
      };
      const observer = new ResizeObserver(update);
      observer.observe(root);
      const interval = window.setInterval(update, 120);
      window.addEventListener("resize", update);
      document.addEventListener("fullscreenchange", update);
      stopGeometry = () => {
        observer.disconnect(); window.clearInterval(interval);
        window.removeEventListener("resize", update); document.removeEventListener("fullscreenchange", update);
        backgrounds?.restore();
        root.classList.remove("dtv-native-player");
      };
      void adapter.ready.then(() => {
        if (disposed) return;
        backgrounds = revealVideo(root); backgrounds.setActive(!pip); previous = ""; update();
      }).catch(() => {});
      player.on("destroy", () => { void this.dispose(); });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopGeometry?.(); unlisten(); unlistenPip();
      await adapter.dispose();
    },
  };
}
