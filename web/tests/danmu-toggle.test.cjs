const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

// ===== 场景 1/2：danmuOverlay 的关闭→开启恢复链路（mock danmu.js）=====

function loadOverlayModule(fakeDanmuCalls) {
  // createDanmuOverlay → ensureDanmuOverlayHost 需要全局 document
  const sharedHost = { className: '', style: { setProperty() {} }, innerHTML: '', offsetHeight: 0, parentElement: null };
  const sandboxDocument = { createElement: () => sharedHost };
  const DanmuJs = function (config) {
    this.config = config;
    fakeDanmuCalls.push({ type: 'construct', config });
    for (const method of ['start', 'pause', 'play', 'stop', 'clear', 'sendComment']) {
      this[method] = (arg) => {
        fakeDanmuCalls.push({ type: method, arg });
      };
    }
    this.setOpacity = () => {};
    this.setFontSize = () => {};
    this.setArea = () => {};
    this.setAllDuration = () => {};
    this.hide = () => {};
    this.show = () => {};
  };
  const target = path.join(__dirname, '../src/components/player/danmuOverlay.ts');
  const output = ts.transpileModule(fs.readFileSync(target, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const exports = {};
  const load = (file) => {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText;
    const subExports = {};
    vm.runInNewContext(code, { exports: subExports, require: (id) => (id === '@tauri-apps/plugin-os' ? { platform: async () => 'windows' } : require(id)) }, { filename: file });
    return subExports;
  };
  vm.runInNewContext(output, {
    exports,
    document: sandboxDocument,
    require: (id) => {
      if (id === 'danmu.js') return DanmuJs;
      if (id === './constants') return load(path.join(__dirname, '../src/components/player/constants.ts'));
      return require(id);
    }
  }, { filename: target });
  return exports;
}

const SETTINGS = { color: '#fff', strokeColor: '#000', fontSize: '20px', duration: 12000, area: 0.75, mode: 'scroll', opacity: 0.9 };

function makeOverlayModule() {
  const calls = [];
  const mod = loadOverlayModule(calls);
  const host = { className: '', style: { setProperty() {} }, innerHTML: '', offsetHeight: 0, parentElement: null };
  const fakePlayer = {
    root: { querySelector: () => null, appendChild() {} },
    video: { currentTime: 0 }
  };
  const overlay = mod.createDanmuOverlay(fakePlayer, SETTINGS, true);
  return { mod, calls, overlay };
}

test('关闭后重新开启：先清积压弹幕池，再恢复 start+play 渲染', () => {
  const { mod, calls, overlay } = makeOverlayModule();
  const methods = () => calls.map((c) => c.type);
  const idx = (name) => methods().lastIndexOf(name);

  // 挂载时开启 → ensureStarted 已 start
  assert.ok(methods().includes('start'), '挂载开启时应 start');

  // 用户关闭
  mod.syncDanmuEnabledState(overlay, SETTINGS, false);
  assert.equal(methods().at(-1), 'pause');

  // 重新开启（DTV 在开启边沿会先 clear，再 sync(true)）
  overlay.clear();
  mod.syncDanmuEnabledState(overlay, SETTINGS, true);
  assert.ok(idx('clear') > idx('pause'), '重新开启前应 clear 清积压');
  assert.ok(idx('play') > idx('clear'), 'clear 后应 play 恢复渲染');
  assert.notEqual(idx('play'), -1);
});

test('关闭期间 sendComment 被丢弃，恢复后正常转发', () => {
  const { mod, calls, overlay } = makeOverlayModule();
  const sendCount = () => calls.filter((c) => c.type === 'sendComment').length;

  mod.syncDanmuEnabledState(overlay, SETTINGS, false);
  overlay.sendComment({ id: '1', txt: '关着的弹幕' });
  assert.equal(sendCount(), 0, '关闭期间不应转发弹幕');

  overlay.clear();
  mod.syncDanmuEnabledState(overlay, SETTINGS, true);
  overlay.sendComment({ id: '2', txt: '恢复的弹幕' });
  assert.equal(sendCount(), 1, '重新开启后应恢复转发');
  assert.equal(calls.find((c) => c.type === 'sendComment').arg.txt, '恢复的弹幕');
});

test('clear 会真正清空 danmu.js 内部池（调 danmu.clear 而非只清 DOM）', () => {
  const { calls, overlay } = makeOverlayModule();
  overlay.clear();
  assert.ok(calls.some((c) => c.type === 'clear'), 'clear 必须转发到 danmu.clear()');
});

// ===== 场景 3：MainPlayer 监听器闭包读 ref（源码断言）=====

test('弹幕监听器读取 isDanmuEnabledRef.current，开关切换后不再被旧闭包丢弃', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
  // 监听器回调用 ref 而非闭包 state
  assert.match(source, /isDanmuEnabledRef\.current && overlay\?\.sendComment/);
  assert.doesNotMatch(source, /if \(isDanmuEnabled && overlay\?\.sendComment\)/);
  // startDanmaku 依赖数组不得包含 isDanmuEnabled（否则闭包语义回归）
  assert.match(source, /\[isSessionActive, clearDanmakuListeners\]/);
  // 从关到开边沿先 clear
  assert.match(source, /turningOn[\s\S]{0,400}danmuOverlayRef\.current\?\.clear\?\.\(\)/);
});
