const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');
const plain = (x) => JSON.parse(JSON.stringify(x));
function load(file, overrides = {}) {
  const target = path.resolve(__dirname, '../src', file);
  const output = ts.transpileModule(fs.readFileSync(target, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, window: overrides.window, globalThis, require: (id) => overrides[id] ?? (id.startsWith('.') ? load(path.relative(path.resolve(__dirname, '../src'), path.resolve(path.dirname(target), id + '.ts'))) : require(id)) });
  return exports;
}
function storage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), json: (key) => JSON.parse(data.get(key)) };
}
const s = (id, categoryName, popularity = 4) => ({ platform: 'HUYA', id, nickname: id, avatarUrl: '', currentRoomId: id, liveStatus: 'LIVE', categoryName, categoryId: 'game-' + id, popularity });

test('导出和解析LAN同步同时清除主播和listOrder旧热度，分类仍可携带', () => {
  const sync = load('services/lanSync.ts');
  const item = s('1', '英雄联盟');
  const local = storage({ followedStreamers: [item], followListOrder: [{ type: 'streamer', data: item }] });
  const payload = sync.createLanSyncPayload(local);
  for (const key of ['followedStreamers', 'followListOrder']) {
    const saved = JSON.parse(payload.entries[key])[0];
    const entry = key === 'followListOrder' ? saved.data : saved;
    assert.equal(Object.hasOwn(entry, 'popularity'), false);
    assert.equal(entry.categoryName, '英雄联盟');
    assert.equal(entry.categoryId, 'game-1');
  }
  payload.entries.followedStreamers = JSON.stringify([item]);
  assert.equal(Object.hasOwn(JSON.parse(sync.parseLanSyncPayload(payload).entries.followedStreamers)[0], 'popularity'), false);
});

test('增量导入保留新分类、补充旧关注缺失分类、保留本地已有分类及人工顺序', () => {
  const sync = load('services/lanSync.ts');
  const localItem = s('1', '英雄联盟');
  const oldItem = { ...s('2', undefined), categoryId: undefined };
  const local = storage({ followedStreamers: [localItem, oldItem], followListOrder: [{ type: 'streamer', data: oldItem }, { type: 'streamer', data: localItem }] });
  const remote = storage({ followedStreamers: [s('1', 'PUBG'), s('2', 'Minecraft'), s('3', 'VALORANT')] });
  const result = sync.applyIncrementalLanSyncImport(local, sync.collectLanSyncEntries(remote));
  assert.equal(result.addedStreamers, 1);
  assert.deepEqual(local.json('followedStreamers').map(item => [item.id, item.categoryName, Object.hasOwn(item, 'popularity')]), [['1', '英雄联盟', false], ['2', '我的世界', false], ['3', '无畏契约', false]]);
  assert.deepEqual(local.json('followListOrder').map(item => item.data.id), ['2', '1', '3']);
});

test('只有本地listOrder保存分类时，旧格式同步不抹掉缓存', () => {
  const sync = load('services/lanSync.ts');
  const item = s('1', '英雄联盟');
  const local = storage({ followedStreamers: [{ ...item, categoryName: undefined, categoryId: undefined }], followListOrder: [{ type: 'streamer', data: item }] });
  sync.applyIncrementalLanSyncImport(local, { followedStreamers: JSON.stringify([{ ...item, categoryName: undefined, categoryId: undefined }]) });
  assert.equal(local.json('followedStreamers')[0].categoryName, '英雄联盟');
  assert.equal(local.json('followedStreamers')[0].categoryId, 'game-1');
});

function providerHarness(local) {
  const state = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, pending = [], dirty = false, value;
  const react = {
    createContext: () => ({ Provider: {} }), createElement: (_type, props) => { value = props.value; return null; },
    useState: (initial) => { const i = stateIndex++; if (!(i in state)) state[i] = initial; return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next; dirty = true; }]; },
    useRef: (initial) => { const i = refIndex++; if (!(i in refs)) refs[i] = { current: initial }; return refs[i]; },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
    useEffect: (fn, deps) => { const i = effectIndex++, old = effects[i]; if (!old || deps.some((d, j) => d !== old[j])) pending.push(fn); effects[i] = deps; }
  };
  react.default = react;
  const provider = load('state/follow/FollowProvider.tsx', { react, uuid: { v4: () => 'test-folder' }, window: { localStorage: local } });
  const render = () => { let turns = 0; do { if (++turns > 20) throw Error('render loop'); dirty = false; stateIndex = refIndex = effectIndex = 0; pending = []; provider.FollowProvider({ children: null }); pending.forEach(fn => fn()); } while (dirty); return value; };
  render();
  return { get value() { return value; }, render };
}

test('Provider载入清除旧热度、双份来源保留分类且保持既有列表顺序', () => {
  const item = s('1', '英雄联盟');
  const stale = { ...item, categoryName: undefined, categoryId: undefined };
  const folder = { id: 'f', name: '收藏', streamerIds: ['HUYA:1'], expanded: false };
  const local = storage({ followedStreamers: [item], followFolders: [folder], followListOrder: [{ type: 'folder', data: folder }, { type: 'streamer', data: stale }] });
  const app = providerHarness(local);
  assert.equal(app.value.viewMode, undefined);
  assert.equal(app.value.followedStreamers[0].categoryName, '英雄联盟');
  assert.equal(Object.hasOwn(app.value.followedStreamers[0], 'popularity'), false);
  const order = plain(app.value.listOrder), stored = local.getItem('followListOrder');
  app.render();
  assert.deepEqual(plain(app.value.listOrder), order);
  assert.equal(local.getItem('followListOrder'), stored);
  assert.equal(order[0].type, 'folder');
});

test('Provider单条及批量刷新同样保持缓存、清离线热度且持久化不含热度', () => {
  const item = s('1', '英雄联盟');
  const local = storage({ followedStreamers: [item] });
  const app = providerHarness(local);
  app.value.updateStreamer('HUYA', '1', { categoryName: 'PUBG', categoryId: 'pubg', liveStatus: 'LIVE', popularity: 0 }); app.render();
  assert.equal(app.value.followedStreamers[0].categoryName, '绝地求生');
  assert.equal(app.value.followedStreamers[0].popularity, 0);
  app.value.updateStreamers([{ platform: 'HUYA', id: '1', patch: { categoryName: '其他', liveStatus: 'OFFLINE' } }]); app.render();
  assert.equal(app.value.followedStreamers[0].categoryName, '绝地求生');
  assert.equal(Object.hasOwn(app.value.followedStreamers[0], 'popularity'), false);
  assert.equal(Object.hasOwn(local.json('followedStreamers')[0], 'popularity'), false);
  assert.equal(Object.hasOwn(local.json('followListOrder')[0].data, 'popularity'), false);
});

test('同一分类旧格式副本没有分类ID时Provider保留已知ID', () => {
  const item = s('1', '英雄联盟');
  const local = storage({ followedStreamers: [item], followListOrder: [{ type: 'streamer', data: { ...item, categoryId: undefined } }] });
  assert.equal(providerHarness(local).value.followedStreamers[0].categoryId, 'game-1');
});

test('Provider离线首次分类、变更和失败缓存均可重启恢复且不改变文件夹归属和顺序', () => {
  const offline = { ...s('offline', undefined), categoryId: undefined, liveStatus: 'OFFLINE' };
  const unknown = { ...s('unknown', undefined), categoryId: undefined, liveStatus: 'UNKNOWN' };
  const top = { ...s('top', '我的世界'), liveStatus: 'OFFLINE' };
  const folder = { id: 'folder', name: '手动收藏', streamerIds: ['HUYA:offline', 'HUYA:unknown'], expanded: false };
  const local = storage({ followedStreamers: [offline, unknown, top], followFolders: [folder], followListOrder: [{ type: 'folder', data: folder }, { type: 'streamer', data: top }] });
  const app = providerHarness(local);
  const order = plain(app.value.listOrder).map(item => [item.type, item.data.id]);
  app.value.updateStreamer('HUYA', 'offline', { categoryName: 'LOL', categoryId: 'lol', popularity: 88 }); app.render();
  assert.equal(app.value.followedStreamers.find(s => s.id === 'offline').categoryName, '英雄联盟');
  app.value.updateStreamers([
    { platform: 'HUYA', id: 'offline', patch: { liveStatus: 'OFFLINE', categoryName: 'PUBG', categoryId: 'pubg', popularity: 100 } },
    { platform: 'HUYA', id: 'unknown', patch: { categoryName: 'VALORANT', categoryId: 'val', popularity: 0 } }
  ]); app.render();
  app.value.updateStreamers([
    { platform: 'HUYA', id: 'offline', patch: { categoryName: '', categoryId: '' } },
    { platform: 'HUYA', id: 'unknown', patch: {} }
  ]); app.render();
  const restarted = providerHarness(local);
  assert.deepEqual(plain(restarted.value.followedStreamers).map(item => [item.id, item.liveStatus, item.categoryName, Object.hasOwn(item, 'popularity')]), [['offline', 'OFFLINE', '绝地求生', false], ['unknown', 'UNKNOWN', '无畏契约', false], ['top', 'OFFLINE', '我的世界', false]]);
  assert.deepEqual(plain(restarted.value.folders), [folder]);
  assert.deepEqual(plain(restarted.value.listOrder).map(item => [item.type, item.data.id]), order);
});

test('离线和UNKNOWN分类经LAN导出导入后由Provider重启保留，不把热度带给新端', () => {
  const sync = load('services/lanSync.ts');
  const items = [{ ...s('offline', '英雄联盟'), liveStatus: 'OFFLINE' }, { ...s('unknown', '无畏契约'), liveStatus: 'UNKNOWN' }];
  const folder = { id: 'remote-folder', name: '收藏', streamerIds: ['HUYA:offline'], expanded: true };
  const source = storage({ followedStreamers: items, followFolders: [folder], followListOrder: [{ type: 'folder', data: folder }, { type: 'streamer', data: items[1] }] });
  const payload = sync.parseLanSyncPayload(sync.createLanSyncPayload(source));
  const target = storage();
  sync.applyIncrementalLanSyncImport(target, payload.entries);
  const restarted = providerHarness(target);
  assert.deepEqual(plain(restarted.value.followedStreamers).map(item => [item.id, item.liveStatus, item.categoryName, item.categoryId, Object.hasOwn(item, 'popularity')]), [['offline', 'OFFLINE', '英雄联盟', 'game-offline', false], ['unknown', 'UNKNOWN', '无畏契约', 'game-unknown', false]]);
  assert.deepEqual(plain(restarted.value.folders[0].streamerIds), ['HUYA:offline']);
  assert.deepEqual(plain(restarted.value.listOrder).map(item => [item.type, item.data.id]), [['folder', 'remote-folder'], ['streamer', 'unknown']]);
});

test('Provider单条及批量相同刷新保持主播和顺序数组引用避免重复持久化', () => {
  const item = { ...s('1', '英雄联盟'), liveStatus: 'OFFLINE' };
  const app = providerHarness(storage({ followedStreamers: [item] }));
  const followed = app.value.followedStreamers, order = app.value.listOrder;
  app.value.updateStreamer('HUYA', '1', { categoryName: 'LOL', categoryId: 'game-1', liveStatus: 'OFFLINE' }); app.render();
  assert.equal(app.value.followedStreamers, followed);
  assert.equal(app.value.listOrder, order);
  app.value.updateStreamers([{ platform: 'HUYA', id: '1', patch: { categoryName: '英雄联盟', liveStatus: 'OFFLINE' } }]); app.render();
  assert.equal(app.value.followedStreamers, followed);
  assert.equal(app.value.listOrder, order);
});


test('关注筛选提升到Provider，重建列表或重启后保持直播中及所选平台', () => {
  const local = storage();
  const app = providerHarness(local);
  assert.equal(app.value.statusFilter, 'ALL');
  assert.equal(app.value.platformFilter, 'ALL');
  const order = app.value.listOrder;
  app.value.setStatusFilter('LIVE'); app.value.setPlatformFilter('HUYA'); app.render();
  assert.equal(app.value.statusFilter, 'LIVE');
  assert.equal(app.value.platformFilter, 'HUYA');
  assert.equal(app.value.listOrder, order);
  assert.deepEqual(local.json('dtv_follow_filters_v1'), { platform: 'HUYA', status: 'LIVE' });
  // 全屏期间关注组件卸载不应销毁Provider；即使Provider重新创建也从本地恢复。
  const restored = providerHarness(local);
  assert.equal(restored.value.statusFilter, 'LIVE');
  assert.equal(restored.value.platformFilter, 'HUYA');
  restored.value.setStatusFilter('OFFLINE'); restored.render();
  assert.equal(providerHarness(local).value.statusFilter, 'OFFLINE');
  restored.value.setStatusFilter('ALL'); restored.value.setPlatformFilter('ALL'); restored.render();
  assert.deepEqual(local.json('dtv_follow_filters_v1'), { platform: 'ALL', status: 'ALL' });
});

test('损坏或旧版筛选配置回退默认，不影响关注数据', () => {
  for (const filters of [null, [], 'LIVE', { platform: 'invalid', status: 'invalid' }]) {
    const item = s('1', '英雄联盟');
    const app = providerHarness(storage({ followedStreamers: [item], dtv_follow_filters_v1: filters }));
    assert.equal(app.value.platformFilter, 'ALL');
    assert.equal(app.value.statusFilter, 'ALL');
    assert.equal(app.value.followedStreamers[0].id, '1');
  }
});
