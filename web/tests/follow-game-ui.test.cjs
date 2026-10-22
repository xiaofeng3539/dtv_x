const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function loadTs(file, requireModule) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: requireModule, console, document: { body: {} } }, { filename: file });
  return exports;
}

function renderFollow(overlay = false, filters = {}) {
  const streamers = [
    { platform: 'DOUYU', id: '1', nickname: '甲主播', avatarUrl: '', liveStatus: 'LIVE', categoryName: 'LOL' },
    { platform: 'TWITCH', id: '1', nickname: '乙主播', avatarUrl: '', liveStatus: 'LIVE', categoryName: 'League of Legends' },
    { platform: 'HUYA', id: '2', nickname: '丙主播', avatarUrl: '', liveStatus: 'UNKNOWN' }
  ];
  const follow = { platformFilter: "ALL", statusFilter: "ALL", setPlatformFilter() {}, setStatusFilter() {}, ...filters, followedStreamers: streamers,
    listOrder: streamers.map(data => ({ type: 'streamer', data })), folders: [], hydrated: true };
  let stateIndex = 0;
  const react = { ...React, useState(initial) { return React.useState(overlay && stateIndex++ === 1 ? true : initial); } };
  const motion = new Proxy({}, { get(_t, tag) { return ({ children, ...props }) => {
    for (const key of ['initial', 'animate', 'exit', 'transition', 'layout', 'layoutId']) delete props[key];
    return React.createElement(tag, props, children);
  }; } });
  const importer = (id) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return require(id);
    if (id === 'react-dom') return { createPortal: children => children };
    if (id === 'next/navigation') return { usePathname: () => '/' };
    if (id === '@tauri-apps/api/core') return { invoke: async () => ({}) };
    if (id === 'framer-motion') return { m: motion, AnimatePresence: ({ children }) => children,
      useMotionValue: () => ({ set() {} }), useSpring: () => 0 };
    if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (id.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_t, key) => key }) };
    if (id.endsWith('/FollowRefreshProvider')) return { useFollowRefresh: () => ({ isRefreshing: false, progressCurrent: 0, progressTotal: 0, showCheckIcon: false, refreshList: async () => {} }) };
    if (id.endsWith('/FollowProvider')) return { useFollow: () => follow };
    if (id.endsWith('/followGrouping')) return loadTs(path.join(__dirname, '../src/state/follow/followGrouping.ts'), importer);
    if (id.endsWith('/SettingsProvider')) return { useAppSettings: () => ({ settings: { followPollIntervalMin: 0 } }) };
    if (id.endsWith('/useImageProxy')) return { useImageProxy: () => ({ ensureProxyStarted() {}, getAvatarSrc: () => '' }) };
    if (id.endsWith('/PlayerOverlayProvider')) return { usePlayerOverlay: () => ({ openPlayer() {} }) };
    if (id.endsWith('/common/types')) return { Platform: {} };
    throw new Error(`未提供外部依赖 ${id}`);
  };
  const { FollowsList } = loadTs(path.join(__dirname, '../src/components/follows/FollowsList.tsx'), importer);
  return { html: renderToStaticMarkup(React.createElement(FollowsList)), follow };
}

test('关注侧栏始终游戏分组：跨平台合并，人数与主播卡片完整显示，无模式切换', () => {
  const { html, follow } = renderFollow();
  assert.match(html, /data-follow-category="英雄联盟"/);
  assert.match(html, /2人/);
  assert.match(html, /其他/);
  for (const name of ['甲主播', '乙主播', '丙主播']) assert.match(html, new RegExp(name));
  assert.doesNotMatch(html, />游戏分组<\/button>/);
  assert.doesNotMatch(html, />文件夹<\/button>/);
  assert.equal(follow.listOrder.length, 3);
});

test('展开关注面板与侧栏共用游戏组并保留管理及筛选入口，无文件夹入口', () => {
  const { html } = renderFollow(true);
  assert.equal((html.match(/data-follow-category="英雄联盟"/g) || []).length, 2);
  assert.match(html, /管理/);
  assert.match(html, /直播中/);
  assert.match(html, /未开播/);
  assert.doesNotMatch(html, />游戏分组<\/button>/);
  assert.doesNotMatch(html, /新建文件夹/);
});


test('全屏卸载后重新挂载的侧栏和展开面板读取同一筛选，不复位全部', () => {
  for (const overlay of [false, true, false]) {
    const { html } = renderFollow(overlay, { statusFilter: 'LIVE', platformFilter: 'DOUYU' });
    assert.match(html, /<option value="LIVE" selected="">直播中<\/option>/);
    assert.match(html, /<option value="DOUYU" selected="">斗鱼<\/option>/);
    assert.match(html, /甲主播/);
    assert.doesNotMatch(html, /乙主播|丙主播/);
  }
});
