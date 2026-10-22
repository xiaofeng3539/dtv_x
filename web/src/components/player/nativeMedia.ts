/** HTML media contract for the existing xgplayer controls, without browser networking. */
export type NativeSnapshot = {
  generation: number;
  loaded: boolean;
  paused: boolean;
  buffering: boolean;
  ended: boolean;
  position: number | null;
  cacheEnd: number | null;
  width: number | null;
  height: number | null;
  volume: number;
  muted: boolean;
  error: string | null;
};

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
let nextGeneration = Date.now() * 1000;

// Simple Live's LivePlayUrl headers, not the headers of metadata/search requests.
export function nativeMediaHeaders(platform: string): Record<string, string> {
  if (platform === "BILIBILI") return {
    Referer: "https://live.bilibili.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.1901.188",
  };
  if (platform === "HUYA") return {
    "User-Agent": "HYSDK(Windows, 30000002)_APP(pc_exe&7060000&official)_SDK(trans&2.32.3.5646)",
  };
  return {};
}

export function createNativeMedia(
  video: HTMLVideoElement,
  invoke: Invoke,
  headers: Readonly<Record<string, string>> = {},
) {
  let mediaHeaders = { ...headers };
  let disposed = false;
  let generation = 0;
  let src = "";
  let pip = false;
  let state: NativeSnapshot = {
    generation: 0, loaded: false, paused: true, buffering: false, ended: false,
    position: null, cacheEnd: null, width: null, height: null, volume: 1, muted: false, error: null,
  };
  let opened: Promise<unknown> = Promise.resolve();
  const emit = (name: string) => { if (!disposed) video.dispatchEvent(new Event(name)); };
  const fail = (error: unknown, owner: number) => {
    if (disposed || owner !== generation) return;
    state = { ...state, loaded: false, buffering: false, error: String(error) };
    emit("error");
  };
  const control = (command: string, args: Record<string, unknown> = {}) => {
    const owner = generation;
    if (disposed || owner === 0) return Promise.resolve();
    // Controls must follow their open, including a slow first kernel initialization.
    return opened.then(() => {
      if (!disposed && owner === generation) return invoke(command, { generation: owner, ...args });
    }).catch(error => fail(error, owner));
  };
  const setSource = (value: string) => {
    if (disposed) return;
    src = value || "";
    const previous = generation;
    if (!src) {
      generation = 0;
      state = { ...state, loaded: false, paused: true, position: null, cacheEnd: null };
      if (previous) void opened.catch(() => {}).then(() => invoke("native_player_stop", { generation: previous })).catch(() => {});
      emit("emptied");
      return;
    }
    generation = ++nextGeneration;
    const owner = generation;
    state = { ...state, generation, loaded: false, paused: false, buffering: true, ended: false,
      position: null, cacheEnd: null, width: null, height: null, error: null };
    emit("loadstart"); emit("waiting");
    opened = invoke("native_player_open", { generation: owner, url: src, headers: { ...mediaHeaders } }).then(async () => {
      if (disposed || owner !== generation) return;
      await invoke("native_player_volume", { generation: owner, volume: state.volume });
      await invoke("native_player_muted", { generation: owner, muted: state.muted });
    });
    // Keep the rejection for callers while always observing it, so no unhandled promise remains.
    void opened.catch(error => fail(error, owner));
  };
  const emptyRanges: TimeRanges = { length: 0, start: () => { throw new RangeError("Empty live range"); }, end: () => { throw new RangeError("Empty live range"); } };
  Object.defineProperties(video, {
    src: { configurable: true, get: () => src, set: setSource },
    currentSrc: { configurable: true, get: () => src, set: () => {} },
    paused: { configurable: true, get: () => state.paused },
    ended: { configurable: true, get: () => state.ended },
    readyState: { configurable: true, get: () => state.loaded ? 4 : 0 },
    networkState: { configurable: true, get: () => state.buffering ? 2 : src ? 1 : 0 },
    currentTime: { configurable: true, get: () => state.position ?? 0, set: () => {} },
    duration: { configurable: true, get: () => Infinity },
    videoWidth: { configurable: true, get: () => state.width ?? 0 },
    videoHeight: { configurable: true, get: () => state.height ?? 0 },
    seekable: { configurable: true, get: () => emptyRanges },
    buffered: { configurable: true, get: (): TimeRanges => state.cacheEnd === null ? emptyRanges : {
      length: 1,
      start: (index) => { if (index !== 0) throw new RangeError("Invalid live range"); return state.position ?? 0; },
      end: (index) => { if (index !== 0) throw new RangeError("Invalid live range"); return state.cacheEnd!; },
    } },
    volume: { configurable: true, get: () => state.volume, set: (value: number) => {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Invalid volume");
      state.volume = value; emit("volumechange"); void control("native_player_volume", { volume: value });
    } },
    muted: { configurable: true, get: () => state.muted, set: (value: boolean) => {
      state.muted = !!value; emit("volumechange"); void control("native_player_muted", { muted: !!value });
    } },
    error: { configurable: true, get: () => state.error ? { code: 3, message: state.error } : null },
    webkitSupportsPresentationMode: { configurable: true, value: true },
    webkitPresentationMode: { configurable: true, get: () => pip ? "picture-in-picture" : "inline" },
    webkitSetPresentationMode: { configurable: true, value: (mode: string) => {
      void control("native_player_pip", { enabled: mode === "picture-in-picture" });
    } },
    play: { configurable: true, value: () => {
      state.paused = false; emit("play"); return control("native_player_pause", { paused: false });
    } },
    pause: { configurable: true, value: () => {
      state.paused = true; emit("pause"); void control("native_player_pause", { paused: true });
    } },
    // xgplayer calls load immediately after assigning src; opening twice would discard the first frame.
    load: { configurable: true, value: () => {} },
  });
  const setAttribute = video.setAttribute.bind(video);
  const removeAttribute = video.removeAttribute.bind(video);
  video.setAttribute = (name, value) => { if (name.toLowerCase() === "src") setSource(value); else setAttribute(name, value); };
  video.removeAttribute = (name) => { if (name.toLowerCase() === "src") setSource(""); else removeAttribute(name); };

  return {
    video,
    setHeaders(next: Readonly<Record<string, string>>) { mediaHeaders = { ...next }; },
    get generation() { return generation; },
    get ready() { return opened; },
    accept(next: NativeSnapshot) {
      if (disposed || next.generation !== generation || generation === 0) return;
      const previous = state;
      state = { ...next };
      if (state.error && state.error !== previous.error) emit("error");
      if (state.loaded && !previous.loaded) { emit("loadedmetadata"); emit("loadeddata"); emit("canplay"); emit("canplaythrough"); }
      if (state.buffering && !previous.buffering) emit("waiting");
      if (state.loaded && state.position !== null && !state.buffering && !state.paused &&
          (!previous.loaded || previous.position === null || previous.buffering || previous.paused)) emit("playing");
      if (state.paused !== previous.paused) emit(state.paused ? "pause" : "play");
      if (state.position !== previous.position) emit("timeupdate");
      if (state.cacheEnd !== previous.cacheEnd) emit("progress");
      if (state.volume !== previous.volume || state.muted !== previous.muted) emit("volumechange");
      if (state.ended && !previous.ended) emit("ended");
    },
    acceptPip(owner: number, enabled: boolean) {
      if (disposed || owner !== generation) return;
      pip = enabled; emit("webkitpresentationmodechanged");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const owner = generation;
      state = { ...state, loaded: false, paused: true, position: null, cacheEnd: null };
      if (owner) {
        try { await opened; } catch { /* Stop also cleans up a failed open. */ }
        await invoke("native_player_stop", { generation: owner }).catch(() => {});
      }
    },
  };
}
