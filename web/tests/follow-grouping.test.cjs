const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');
const file = path.join(__dirname, '../src/state/follow/followGrouping.ts');
const exportsObject = {};
if (fs.existsSync(file)) vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: exportsObject });
const { normalizeFollowCategory, buildFollowGameGroups, mergeFollowMetadata, stripFollowRuntime } = exportsObject;
const plain = (value) => JSON.parse(JSON.stringify(value));
const streamer = (platform, id, categoryName, liveStatus = 'LIVE', popularity) => ({ platform, id, categoryName, liveStatus, popularity, nickname: id, avatarUrl: '', currentRoomId: id });

test('分类归一化合并明确别名、移除专区并保留未知有效分类显示含义', () => {
  assert.equal(typeof normalizeFollowCategory, 'function');
  for (const [input, output] of [[null, '其他'], [undefined, '其他'], [0, '其他'], ['', '其他'], ['未知', '其他'], ['未分类', '其他'], ['其他专区', '其他'], ['null专区', '其他'], [' LOL 专区 ', '英雄联盟'], ['League of Legends', '英雄联盟'], ['英雄联盟（lol）', '英雄联盟'], ['VALORANT', '无畏契约'], ['PUBG', '绝地求生'], ['Minecraft', '我的世界'], ['Naraka: Bladepoint', '永劫无间'], ['CS2', 'CS2'], ['Counter-Strike 2', 'CS2'], ['Dota 2', 'DOTA2'], ['Dota2', 'DOTA2'], ['  Indie Game 专区 ', 'Indie Game']]) assert.equal(normalizeFollowCategory(input), output);
});

test('先按平台和状态过滤再去重计数，其他永远最后', () => {
  assert.equal(typeof buildFollowGameGroups, 'function');
  const items = [streamer('HUYA', '1', 'LOL'), streamer('DOUYU', '1', 'PUBG'), streamer('HUYA', '2', 'PUBG', 'OFFLINE'), streamer('HUYA', '1', 'VALORANT'), streamer('HUYA', '3', '其他'), streamer('DOUYU', '4', 'LOL', 'UNKNOWN')];
  assert.deepEqual(plain(buildFollowGameGroups(items, 'ALL', 'ALL')).map(g => [g.name, g.liveCount, g.members.length]), [['英雄联盟', 1, 2], ['绝地求生', 1, 2], ['其他', 1, 1]]);
  assert.deepEqual(plain(buildFollowGameGroups(items, 'HUYA', 'OFFLINE')).map(g => [g.name, g.liveCount, g.members[0].id]), [['绝地求生', 0, '2']]);
  assert.deepEqual(plain(buildFollowGameGroups(items, 'DOUYU', 'LIVE')).map(g => g.name), ['绝地求生']);
});

test('分类人数降序、并列稳定、英文casefold合组且不改变输入', () => {
  assert.equal(typeof buildFollowGameGroups, 'function');
  const items = [streamer('HUYA', '1', 'Indie Game'), streamer('HUYA', '2', 'Minecraft'), streamer('DOUYU', '3', 'indie game'), streamer('HUYA', '4', 'PUBG'), streamer('HUYA', '5', '其他')];
  const before = plain(items);
  const groups = plain(buildFollowGameGroups(items, 'ALL', 'ALL'));
  assert.deepEqual(groups.map(g => [g.name, g.liveCount]), [['Indie Game', 2], ['我的世界', 1], ['绝地求生', 1], ['其他', 1]]);
  assert.equal(groups[0].key, 'indie game');
  assert.deepEqual(plain(items), before);
});

test('组内平台优先，同平台已知热度降序、零值有效、unknown最后和同数稳定', () => {
  assert.equal(typeof buildFollowGameGroups, 'function');
  const items = [streamer('HUYA', 'unknown', 'LOL'), streamer('HUYA', 'zero', 'LOL', 'LIVE', 0), streamer('HUYA', 'a', 'LOL', 'LIVE', 9), streamer('HUYA', 'b', 'LOL', 'LIVE', 9), streamer('DOUYU', 'low', 'LOL', 'LIVE', 1), streamer('DOUYIN', 'high', 'LOL', 'LIVE', 99), streamer('HUYA', 'offline', 'LOL', 'OFFLINE', 999), streamer('HUYA', 'nan', 'LOL', 'LIVE', NaN)];
  assert.deepEqual(plain(buildFollowGameGroups(items, 'ALL', 'ALL'))[0].members.map(s => s.id), ['low', 'a', 'b', 'zero', 'unknown', 'offline', 'nan', 'high']);
  assert.deepEqual(plain(buildFollowGameGroups(items, 'ALL', 'ALL', ['DOUYIN', 'HUYA', 'DOUYU']))[0].members.map(s => s.id), ['high', 'a', 'b', 'zero', 'unknown', 'offline', 'nan', 'low']);
});

test('上一轮人数领先分类在下一轮人数相同时保持稳定顺序', () => {
  assert.equal(typeof buildFollowGameGroups, 'function');
  const first = buildFollowGameGroups([streamer('HUYA', 'a', 'LOL'), streamer('HUYA', 'b', 'PUBG'), streamer('HUYA', 'c', 'PUBG')], 'ALL', 'ALL');
  assert.deepEqual(plain(first).map(g => g.key), ['绝地求生', '英雄联盟']);
  const second = buildFollowGameGroups([streamer('HUYA', 'a', 'LOL'), streamer('HUYA', 'b', 'PUBG'), streamer('HUYA', 'c', 'PUBG', 'OFFLINE')], 'ALL', 'ALL', undefined, first.map(g => g.key));
  assert.deepEqual(plain(second).map(g => g.key), ['绝地求生', '英雄联盟']);
});

test('刷新接收有效分类（含未开播）、失败保留分类缓存且清除离线热度', () => {
  assert.equal(typeof mergeFollowMetadata, 'function');
  const old = streamer('HUYA', '1', '英雄联盟', 'LIVE', 8);
  old.categoryId = 'old';
  // 无效补丁（缺失/空/“其他”）不覆盖有效缓存。
  for (const patch of [{}, { categoryName: '' }, { categoryName: '其他', categoryId: '' }]) assert.equal(mergeFollowMetadata(old, patch).categoryName, '英雄联盟');
  // 未开播时官方接口同样返回分类（真实响应已验证）：有效新分类必须更新缓存并清除过期热度。
  const offline = mergeFollowMetadata(old, { liveStatus: 'OFFLINE', categoryName: 'PUBG', categoryId: 'new', popularity: 5 });
  assert.equal(offline.categoryName, '绝地求生');
  assert.equal(offline.categoryId, 'new');
  assert.equal(Object.hasOwn(offline, 'popularity'), false);
  // UNKNOWN 状态同样接受有效分类。
  const unknown = mergeFollowMetadata(old, { liveStatus: 'UNKNOWN', categoryName: 'VALORANT' });
  assert.equal(unknown.categoryName, '无畏契约');
  const live = mergeFollowMetadata(old, { liveStatus: 'LIVE', categoryName: 'PUBG 专区', categoryId: 'new', popularity: 0 });
  assert.equal(live.categoryName, '绝地求生');
  assert.equal(live.categoryId, 'new');
  assert.equal(live.popularity, 0);
  assert.equal(Object.hasOwn(mergeFollowMetadata(old, { popularity: undefined }), 'popularity'), false);
  assert.equal(mergeFollowMetadata(old, {}), old);
});

test('旧关注兼容且序列化剔除运行时热度但不丢分类、身份或其他字段', () => {
  assert.equal(typeof stripFollowRuntime, 'function');
  const old = { platform: 'HUYA', id: '1', liveStatus: 'UNKNOWN' };
  assert.deepEqual(plain(stripFollowRuntime(old)), { platform: 'HUYA', id: '1' });
  const item = streamer('HUYA', '1', '英雄联盟', 'LIVE', 99);
  item.categoryId = '1';
  const saved = plain(stripFollowRuntime(item));
  assert.equal(Object.hasOwn(saved, 'popularity'), false);
  assert.equal(Object.hasOwn(saved, 'liveStatus'), false);
  assert.equal(saved.categoryName, '英雄联盟');
  assert.equal(saved.categoryId, '1');
  assert.equal(item.popularity, 99);
});

test('未开播首次获取官方分类即可分组，不依赖历史开播缓存', () => {
  const old = streamer('DOUYU', 'offline-first', undefined, 'OFFLINE');
  const classified = mergeFollowMetadata(old, { categoryName: 'League of Legends', categoryId: '1', popularity: 88 });
  assert.equal(classified.liveStatus, 'OFFLINE');
  assert.equal(classified.categoryName, '英雄联盟');
  assert.equal(classified.categoryId, '1');
  assert.equal(Object.hasOwn(classified, 'popularity'), false);
  assert.deepEqual(plain(buildFollowGameGroups([classified], 'ALL', 'OFFLINE')).map(g => [g.name, g.liveCount, g.members[0].id]), [['英雄联盟', 0, 'offline-first']]);
});

test('未开播游戏变更使用本次官方分类，UNKNOWN分类不伪造直播状态或热度', () => {
  const old = { ...streamer('HUYA', 'game-change', '英雄联盟', 'OFFLINE', 99), categoryId: 'old' };
  const changed = mergeFollowMetadata(old, { liveStatus: 'OFFLINE', categoryName: 'PUBG', categoryId: 'new', popularity: 100 });
  assert.equal(changed.categoryName, '绝地求生');
  assert.equal(changed.categoryId, 'new');
  assert.equal(Object.hasOwn(changed, 'popularity'), false);
  const unknown = mergeFollowMetadata(streamer('BILIBILI', 'unknown-first', undefined, 'UNKNOWN'), { categoryName: 'VALORANT', categoryId: '2', popularity: 0 });
  assert.equal(unknown.liveStatus, 'UNKNOWN');
  assert.equal(unknown.categoryName, '无畏契约');
  assert.equal(Object.hasOwn(unknown, 'popularity'), false);
  const groups = plain(buildFollowGameGroups([changed, unknown], 'ALL', 'ALL'));
  assert.deepEqual(groups.map(g => [g.name, g.liveCount]), [['绝地求生', 0], ['无畏契约', 0]]);
});

test('离线和未知状态失败或空分类补丁均不抹掉有效游戏缓存', () => {
  for (const status of ['OFFLINE', 'UNKNOWN']) {
    const old = { ...streamer('HUYA', 'cached', '英雄联盟', status), categoryId: 'old' };
    for (const patch of [{}, ...[undefined, null, '', ' ', 'null', 'undefined', '0', '未知', '未分类', '其他'].map(categoryName => ({ categoryName, categoryId: '' }))]) {
      const actual = mergeFollowMetadata(old, patch);
      assert.equal(actual.categoryName, '英雄联盟');
      assert.equal(actual.categoryId, 'old');
      assert.equal(actual.liveStatus, status);
      assert.equal(Object.hasOwn(actual, 'popularity'), false);
    }
  }
});
