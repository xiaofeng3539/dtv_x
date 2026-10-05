const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function attach() {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
  const tree = ts.createSourceFile('player.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
        node.arguments[0]?.getText(tree).includes('const handlePlayerShortcut')) effect = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(effect, '播放器应注册 D/F 快捷键');
  const listeners = new Map();
  let enabled = true;
  let fullscreen = false;
  const playerRef = { current: { plugins: { fullscreen: { toggleFullScreen() { fullscreen = !fullscreen; } } } } };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(`export const attach = ${effect}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText, { exports, playerRef, setIsDanmuEnabled: (change) => enabled = change(enabled),
    document: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key, fn) => {
      if (listeners.get(key) === fn) listeners.delete(key);
    } } });
  const dispose = exports.attach();
  return { playerRef, dispose, listeners, get enabled() { return enabled; }, get fullscreen() { return fullscreen; },
    press(key, extra = {}) { let prevented = false; listeners.get('keydown')?.({ key, target: { closest: () => null },
      preventDefault: () => prevented = true, ...extra }); return prevented; } };
}

test('D 连续按两次切换弹幕开关，F 连续按两次进入和退出全屏', () => {
  const player = attach();
  assert.equal(player.press('d'), true);
  assert.equal(player.enabled, false);
  player.press('D');
  assert.equal(player.enabled, true);
  player.press('f');
  assert.equal(player.fullscreen, true);
  player.press('F');
  assert.equal(player.fullscreen, false);
});

test('输入框、可编辑区域、输入法、长按和组合键不触发快捷键', () => {
  const player = attach();
  for (const extra of [{ target: { closest: () => ({}) } }, { isComposing: true }, { repeat: true },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(player.press('d', extra), false);
    assert.equal(player.press('f', extra), false);
  }
  assert.equal(player.enabled, true);
  assert.equal(player.fullscreen, false);
  assert.equal(player.press('x'), false);
});

test('没有播放器实例时不响应，卸载后移除监听器', () => {
  const player = attach();
  player.playerRef.current = null;
  assert.equal(player.press('d'), false);
  player.dispose();
  assert.equal(player.listeners.size, 0);
});
