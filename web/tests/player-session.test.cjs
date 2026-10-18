const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
const tree = ts.createSourceFile('player.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(tree) === 'useCallback') {
    callbacks[node.name.getText(tree)] = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const constants = source.slice(source.indexOf('const RECONNECT_COOLDOWN_MS'), source.indexOf('// 单个 Rust invoke'));
const code = ts.transpileModule(`${constants}
  const isSessionActive = ${callbacks.isSessionActive};
  const scheduleReconnect = ${callbacks.scheduleReconnect};
  const reloadStream = ${callbacks.reloadStream};
  const startStallWatchdog = ${callbacks.startStallWatchdog};
  export { reloadStream, startStallWatchdog };
`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 执行真实重载、重连与看门狗；只替换 IPC/播放器边界，控制慢请求的返回顺序。
function setup(fetch, platform = 'DOUYIN') {
  let now = 1000, id = 0, destroyed = 0, mounted = 0, proxyStops = 0;
  const timers = new Map(), intervals = new Map(), ui = {};
  const context = {
    exports: {}, console: { info() {}, warn() {} }, Date: { now: () => now },
    Platform: Object.fromEntries(['DOUYIN', 'DOUYU', 'HUYA', 'BILIBILI', 'TWITCH'].map((key) => [key, key])), platform, roomId: '123',
    lineOptions: [], resolveCurrentLineFor: () => null,
    localStorage: { getItem: () => null }, invoke: async () => ({}),
    currentQuality: '原画', currentLine: null,
    clearReconnectTimer() {},
    stopAllDanmakuBackends: async () => {},
    stopAllProxies: async () => { proxyStops++; },
    applyDanmuFontFamilyForOS: async () => {},
    fetchAndPrepareDouyinStreamConfig: fetch,
    getDouyuStreamConfig: fetch, getHuyaStreamConfig: fetch, getBilibiliStreamConfig: fetch, getTwitchStreamConfig: fetch,
    destroyPlayer() { destroyed++; context.playerRef.current = null; },
    mountPlayer: async () => { mounted++; }, startDanmaku: async () => {},
    isOfflineMessage: () => false, maybeAppendHevcInstallHint: (x) => x,
    commitReconnectHealthy() {}, notePlaybackProgress() {},
    window: {
      setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
      clearTimeout(key) { timers.delete(key); },
      setInterval(fn) { intervals.set(++id, fn); return id; },
    },
  };
  for (const [name, value] of Object.entries({
    disposedRef: false, reloadInFlightRef: false, reloadStartedAtRef: 0, pendingReloadRef: null,
    activeSessionIdRef: 0, sessionSeqRef: 0, streamCandidateIndexRef: 0, streamCandidateCountRef: 1,
    autoReconnectModeRef: false, reconnectAttemptRef: 0, reconnectBlockedRef: false,
    reconnectGaveUpRef: false, reconnectDeferredRef: false, reconnectRoundStartRef: 0,
    fetchFailStreakRef: 0, reconnectCooldownUntilRef: 0, userPausedRef: false,
    reconnectTimerRef: null, playerRef: null, danmuOverlayRef: {}, playbackKindRef: null,
    stallWatchdogRef: null, lastProgressRef: {}, lastBufferedRef: {},
    watchdogCtxRef: { loading: false, hasError: false, offline: false }, reloadStreamRef: null,
    windowHiddenRef: false,
  })) context[name] = { current: value };
  for (const name of ['IsLoadingStream', 'StreamError', 'IsOfflineError', 'PlayerIsLive',
    'PlayerTitle', 'PlayerAnchorName', 'PlayerAvatar', 'QualityOptionsOverride', 'ReconnectNotice']) {
    context[`set${name}`] = (value) => { ui[name] = value; };
  }
  vm.runInNewContext(code, context);
  context.reloadStreamRef.current = context.exports.reloadStream;
  return {
    context, ui, timers, reload: context.exports.reloadStream,
    get destroyed() { return destroyed; }, get mounted() { return mounted; }, get proxyStops() { return proxyStops; },
    advance(ms) { now += ms; for (const fn of intervals.values()) fn(); },
    watch: context.exports.startStallWatchdog,
  };
}

test('首次取流暂时失败，冷却期结束后自动恢复，不必重启应用', async () => {
  let calls = 0;
  const run = setup(async () => {
    if (++calls === 1) throw new Error('网络暂时不可用');
    return { streamUrl: 'https://cdn/live.flv', isLive: true };
  });
  await run.reload('refresh');
  run.watch();
  run.advance(21000);
  assert.equal(run.timers.size, 1, '失败后必须仍有恢复入口');
  for (const task of run.timers.values()) task.fn();
  run.timers.clear();
  await tick();
  assert.equal(calls, 2);
  assert.equal(run.mounted, 1);
  assert.equal(run.ui.PlayerIsLive, true);
  assert.equal(run.ui.IsLoadingStream, false);
});

test('慢旧请求在新请求失败后返回，不能吞掉冷却期内的恢复请求', async () => {
  const old = deferred();
  let calls = 0;
  const run = setup(() => ++calls === 1 ? old.promise : Promise.reject(new Error('网络暂时不可用')));
  const first = run.reload('refresh');
  await tick();
  await run.reload('refresh');
  assert.equal(run.context.reconnectDeferredRef.current, true);
  old.resolve({ streamUrl: 'https://old/live.flv', isLive: true });
  await first;
  run.watch();
  run.advance(21000);
  assert.equal(run.timers.size, 1, '旧会话结束后仍应排定恢复，不能永久黑屏');
  assert.equal(run.mounted, 0);
});

test('旧会话停止弹幕后已被切台抢占，不再停止新会话代理', async () => {
  const stop = deferred();
  const run = setup(async () => ({ streamUrl: 'https://new/live.flv', isLive: true }));
  let calls = 0;
  run.context.stopAllDanmakuBackends = () => ++calls === 1 ? stop.promise : Promise.resolve();
  const first = run.reload('refresh');
  await tick();
  await run.reload('refresh');
  assert.equal(run.mounted, 1);
  stop.resolve();
  await first;
  assert.equal(run.proxyStops, 1, '过期请求不能再次停止当前代理');
});

for (const platform of ['DOUYIN', 'DOUYU', 'HUYA', 'BILIBILI', 'TWITCH']) {
// 兼容返回 thenable 的 SDK/适配层（HLS 会返回 Promise）；FLV 包装无返回值时，
// 异步故障由 player-recovery.test.cjs 的实际事件监听回归覆盖。
test(`${platform} 旧播放器软切换延迟失败，不能销毁后来已加载的播放器`, async () => {
  const switchResult = deferred();
  const kind = platform === 'TWITCH' ? 'hls' : 'flv';
  const run = setup(async () => ({ streamUrl: `https://cdn/live.${kind}`, streamType: kind, isLive: true, qualities: [] }), platform);
  run.context.playerRef.current = { switchURL: () => switchResult.promise };
  run.context.playbackKindRef.current = kind;
  const first = run.reload('refresh');
  await tick();
  run.context.playerRef.current = null;
  await run.reload('refresh');
  const before = run.destroyed;
  switchResult.reject(new Error('旧连接已关闭'));
  await first;
  assert.equal(run.destroyed, before, '旧软切换 catch 不得破坏新播放器');
  assert.equal(run.mounted, 1);
});
}


test('连续取流失败最终显示重试入口，手动重试可以恢复', async () => {
  let calls = 0;
  const run = setup(async () => {
    if (++calls <= 3) throw new Error('网络暂时不可用');
    return { streamUrl: 'https://cdn/live.flv', isLive: true };
  });
  run.watch();
  await run.reload('refresh');
  run.advance(21000);
  for (let i = 0; i < 2; i++) {
    const tasks = [...run.timers.values()];
    run.timers.clear();
    assert.equal(tasks.length, 1);
    tasks[0].fn();
    await tick();
  }
  assert.equal(calls, 3);
  assert.match(run.ui.StreamError, /再试一次/);
  assert.equal(run.ui.PlayerIsLive, null, '网络错误不得冒充关播');
  assert.equal(run.timers.size, 0);
  await run.reload('refresh');
  assert.equal(calls, 4);
  assert.equal(run.mounted, 1);
  assert.equal(run.ui.StreamError, null);
});

test('挂死旧会话晚返回不能解除新会话的重建标记和加载锁', async () => {
  const old = deferred(), next = deferred();
  let calls = 0;
  const run = setup(() => ++calls === 1 ? old.promise : next.promise);
  const first = run.reload('refresh');
  await tick();
  run.advance(21000);
  const second = run.reload('refresh', undefined, { isAutoReconnect: true });
  await tick();
  assert.equal(run.context.autoReconnectModeRef.current, true);
  old.resolve({ streamUrl: 'https://old/live.flv', isLive: true });
  await first;
  assert.equal(run.context.autoReconnectModeRef.current, true);
  assert.equal(run.context.reloadInFlightRef.current, true);
  assert.equal(run.ui.IsLoadingStream, true);
  next.resolve({ streamUrl: 'https://new/live.flv', isLive: true });
  await second;
  assert.equal(run.mounted, 1);
  assert.equal(run.context.autoReconnectModeRef.current, false);
  assert.equal(run.ui.IsLoadingStream, false);
});

test('弹幕初始化缓慢不阻塞已准备好的画面和后续切台', async () => {
  const danmaku = deferred();
  const run = setup(async () => ({ streamUrl: 'https://cdn/live.flv', streamType: 'flv', isLive: true }));
  run.context.playerRef.current = { switchURL() {} };
  run.context.playbackKindRef.current = 'flv';
  run.context.startDanmaku = () => danmaku.promise;
  const pending = run.reload('refresh');
  await tick();
  try {
    assert.equal(run.ui.IsLoadingStream, false, '视频不能等待弹幕 IPC 才解除加载状态');
    assert.equal(run.context.reloadInFlightRef.current, false);
  } finally {
    danmaku.resolve();
    await pending;
  }
});

test('旧会话的播放器模块延迟加载完成后，不能替换新播放器', async () => {
  const imports = deferred();
  let active = true, created = 0;
  const healthy = {};
  const context = {
    exports: {}, console, isSessionActive: () => active,
    playerContainerRef: { current: {} }, playerRef: { current: healthy },
    hevcBrandPatchedRef: { current: false }, supportsMseType: () => true,
    ICONS: {}, POSITIONS: {},
    require: (id) => id === 'xgplayer' ? imports.promise : {},
  };
  vm.runInNewContext(ts.transpileModule(`export const mount = ${callbacks.mountPlayer};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
  }).outputText, context);
  const pending = context.exports.mount(1, 'https://cdn/live.flv', 'flv');
  await tick();
  active = false;
  imports.resolve({ default: function Player() { created++; this.destroy = () => {}; } });
  await pending;
  assert.equal(created, 0, '模块加载完成时须重新检查房间是否仍有效');
  assert.equal(context.playerRef.current, healthy);
});

test('过期弹幕启动请求不得清空当前房间的监听器', async () => {
  let cleared = 0;
  const context = { exports: {}, isSessionActive: () => false, clearDanmakuListeners: () => cleared++ };
  vm.runInNewContext(ts.transpileModule(`export const start = ${callbacks.startDanmaku};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await context.exports.start(1, null, 'DOUYIN', '123');
  assert.equal(cleared, 0);
});

for (const hasBuffer of [false, true]) {
  test(`播放器首次没有画面和进度（buffered=${hasBuffer}），看门狗仍能积累超时并恢复`, () => {
    const run = setup(async () => ({}));
    const video = { currentTime: 0, paused: true, ended: false,
      buffered: { length: hasBuffer ? 1 : 0, end: () => 0 } };
    run.context.playerRef.current = { root: { querySelector: () => video } };
    run.watch();
    run.advance(3000);
    run.advance(46000);
    assert.equal(run.timers.size, 1, '从未起播时也必须恢复，不能每次把超时起点重置为现在');
  });
}

test('连续快速切台 40 次且旧请求倒序返回，仅最后一次加载生效', async () => {
  const requests = [];
  const run = setup(() => { const request = deferred(); requests.push(request); return request.promise; });
  const reloads = [];
  for (let i = 0; i < 40; i++) {
    reloads.push(run.reload('refresh'));
    await tick();
  }
  assert.equal(requests.length, 40);
  requests[39].resolve({ streamUrl: 'https://latest/live.flv', isLive: true, title: '最后房间' });
  await reloads[39];
  for (let i = 38; i >= 0; i--) requests[i].resolve({ streamUrl: 'https://old/live.flv', isLive: true, title: '过期房间' });
  await Promise.all(reloads);
  assert.equal(run.mounted, 1);
  assert.equal(run.ui.PlayerTitle, '最后房间');
  assert.equal(run.ui.IsLoadingStream, false);
  assert.equal(run.timers.size, 0);
});

for(const hasBuffer of [true,false])test('libmpv 连续 15 秒无首帧或进展会恢复，buffer='+hasBuffer,()=>{
 const run=setup(async()=>({}));const video={dataset:{nativePlayback:'true'},currentTime:0,paused:false,ended:false,readyState:0,buffered:{length:hasBuffer?1:0,end:()=>0}};
 run.context.playerRef.current={video,root:{querySelector:()=>video}};run.watch();run.advance(3000);run.advance(15000);
 assert.equal(run.timers.size,1);
});
