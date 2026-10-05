const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configDir = path.join(__dirname, '../../src-tauri');
const base = JSON.parse(fs.readFileSync(path.join(configDir, 'tauri.conf.json'), 'utf8'));
const windowsFile = path.join(configDir, 'tauri.windows.conf.json');
const windows = fs.existsSync(windowsFile)
  ? JSON.parse(fs.readFileSync(windowsFile, 'utf8'))
  : {};
// Tauri 按 RFC 7396 合并配置；平台配置中的 windows 数组会整体替换通用数组。
const effectiveWindows = windows.app?.windows ?? base.app.windows;

test('Windows 主窗口关闭原生标题栏，避免与现有自定义按钮重复', () => {
  assert.equal(effectiveWindows.find((window) => window.label === 'main').decorations, false);
});

test('Windows 平台配置保留原有窗口及 WebView 参数', () => {
  assert.deepEqual(effectiveWindows, base.app.windows.map((window) => ({ ...window, decorations: false })));
});

test('通用配置保留 macOS 原生按钮与覆盖式标题栏', () => {
  const main = base.app.windows.find((window) => window.label === 'main');
  assert.equal(main.decorations, true);
  assert.equal(main.titleBarStyle, 'Overlay');
  assert.deepEqual(main.trafficLightPosition, { x: 18, y: 33 });
});
