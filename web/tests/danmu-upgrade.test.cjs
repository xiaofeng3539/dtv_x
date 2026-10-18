const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

// 使用真实弹幕库；只替代浏览器布局和计时器，不替代弹幕逻辑。
function loadOverlay() {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.nodeType = 1;
      this.style = { setProperty(key, value) { this[key] = value; } };
      this.children = [];
      this.offsetHeight = 600;
      this.className = '';
    }
    appendChild(child) { this.children.push(child); child.parentElement = child.parentNode = this; return child; }
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentElement = child.parentNode = null; }
    contains(child) { return this.children.includes(child); }
    setAttribute(key, value) { this[key] = value; }
    getAttribute(key) { return this[key]; }
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() {
      const left = parseFloat(this.style.left) || 0;
      const width = this.textContent ? 120 : 1000;
      return { left, right: left + width, top: 0, bottom: 600, width, height: this.textContent ? 30 : 600 };
    }
    querySelector(selector) { return this.children.find(child => selector === 'xg-video-container' ? child.tagName === selector : child.className === selector.slice(1)) || null; }
    set innerHTML(value) { this.children = []; }
    get innerHTML() { return ''; }
  }
  const head = new Element('head');
  const frames = [];
  const warnings = [];
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, Node: Element, HTMLElement: Element,
    navigator: { userAgent: 'Windows' }, location: { href: 'http://localhost' },
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }), querySelector: () => head },
    requestAnimationFrame: callback => (frames.push(callback), frames.length), cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {}, Date, Math,
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args), log() {} },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(require.resolve('danmu.js'), 'utf8'), context);
  const Danmu = context.module.exports.default || context.module.exports;
  function loadSource(relative, requireModule) {
    const module = { exports: {} };
    context.module = module;
    context.exports = module.exports;
    context.require = requireModule;
    const source = fs.readFileSync(path.join(__dirname, '../src/components/player', relative), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
    return module.exports;
  }
  const constants = loadSource('constants.ts', () => ({ platform: () => 'windows' }));
  const overlayModule = loadSource('danmuOverlay.ts', name => name === 'danmu.js' ? Danmu : constants);
  const root = new Element();
  const container = root.appendChild(new Element('xg-video-container'));
  const settings = { color: '#ffffff', strokeColor: '#000000', fontSize: '20px', duration: 12000, area: 0.5, opacity: 0.8, mode: 'scroll' };
  const overlay = overlayModule.createDanmuOverlay({ root, video: { currentTime: 1 } }, settings, true);
  while (frames.length) frames.shift()();
  return { overlay, overlayModule, root, host: container.children[0], settings, warnings, Danmu, Element };
}

test('新版真实弹幕库可启动、切换开关并应用字号、区域、速度和透明度', () => {
  const { overlay, overlayModule, root, host, settings, warnings } = loadOverlay();
  assert.ok(overlay, String(warnings));
  assert.equal(host.style['--danmu-opacity'], '0.8');
  overlay.sendComment({ id: 'scroll', txt: '滚动弹幕', mode: 'scroll' });
  overlay.sendComment({ id: 'top', txt: '顶部弹幕', mode: 'top' });
  overlay.sendComment({ id: 'bottom', txt: '底部弹幕', mode: 'bottom' });
  overlayModule.syncDanmuEnabledState(overlay, settings, false, root);
  assert.equal(host.style['--danmu-opacity'], '0');
  overlayModule.syncDanmuEnabledState(overlay, settings, true, root);
  const changed = { ...settings, fontSize: '28px', duration: 18000, area: 0.75, opacity: 0.6 };
  overlayModule.applyDanmuOverlayPreferences(overlay, changed, true, root);
  assert.equal(host.style['--danmu-opacity'], '0.6');
  overlay.setPlayRate('scroll', 1.5);
  overlay.clear();
  overlay.stop();
  assert.deepEqual(warnings, []);
});

test('新版真实引擎保留三种弹幕队列、批量配置和清理行为', () => {
  const { Danmu, Element } = loadOverlay();
  const engine = new Danmu({ container: new Element(), comments: [], defaultOff: true });
  for (const mode of ['scroll', 'top', 'bottom']) engine.sendComment({ id: mode, txt: mode, mode, duration: 12000, style: {} });
  assert.equal(engine.state.comments.length, 3);
  engine.setFontSize(28, 38);
  engine.setArea({ start: 0, end: 0.75 });
  engine.setOpacity(0.6);
  for (const mode of ['scroll', 'top', 'bottom']) engine.setAllDuration(mode, 18000);
  for (const comment of engine.state.comments) {
    assert.equal(comment.style.fontSize, '28px');
    assert.equal(comment.duration, 18000);
  }
  engine.start();
  for (let attempt = 0; attempt < 3; attempt++) {
    engine.main.readData();
    engine.main.dataHandle();
  }
  assert.equal(engine.state.bullets.length, 3);
  assert.equal(engine.container.children.length, 3);
  engine.pause();
  assert.equal(engine.status, 'paused');
  engine.play();
  assert.equal(engine.status, 'playing');
  engine.clear();
  assert.equal(engine.state.comments.length, 0);
  engine.destroy();
});
