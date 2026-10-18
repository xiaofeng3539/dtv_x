const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

const source = fs.readFileSync(path.join(__dirname, '../src/components/follows/FollowsList.tsx'), 'utf8');
const tree = ts.createSourceFile('follows.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'refreshList') callback = node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
const top = source.slice(source.indexOf('const FOLLOW_REFRESH_CONCURRENCY'), source.indexOf('export function FollowsList'));
const code = ts.transpileModule(`${top}\nexport const run = ${callback}; export { refreshOne };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function setup(streamers, query, cores = 2) {
  const calls = [], patches = [], timers = new Map();
  let sequence = 0;
  const exports = {};
  const aliveRef = { current: true }, lock = { current: false };
  const progress = { current: 0, total: 0, refreshing: false };
  const context = { exports, console, navigator: { hardwareConcurrency: cores },
    window: { setTimeout: (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout: (id) => timers.delete(id) },
    invoke: async (command, args) => { calls.push({ command, args }); return query(command, args); },
    follow: { followedStreamers: streamers, updateStreamers: (items) => patches.push(...items) },
    isRefreshingRef: lock, aliveRef,
    setIsRefreshing(value) { progress.refreshing = value; }, setShowCheckIcon() {},
    setProgressTotal(value) { progress.total = value; },
    setProgressCurrent(value) { progress.current = typeof value === "function" ? value(progress.current) : value; },
    PlatformEnum: { BILIBILI: 'BILIBILI', DOUYIN: 'DOUYIN' } };
  vm.runInNewContext(code, context);
  return { exports, calls, patches, timers, lock, aliveRef, progress, follow: context.follow,
    flush() { for (const [id, task] of [...timers]) if (task.ms === 100) { timers.delete(id); task.fn(); } } };
}
const streamer = (platform, id, liveStatus = 'OFFLINE') => ({ platform, id, liveStatus, nickname: id });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('抖音接口错误和未知状态不能把正在直播的关注标成未直播', async () => {
  for (const response of [{ status: null, error_message: '请求超时' }, { status: 0 }, {}]) {
    const run = setup([streamer('DOUYIN', '123', 'LIVE')], () => response);
    await assert.rejects(run.exports.refreshOne(streamer('DOUYIN', '123', 'LIVE')));
    assert.equal(run.patches.length, 0);
  }
});

test('按参考项目限制并发到 4–20，并交错启动不同平台', async () => {
  for (const [cores, expected] of [[1, 4], [2, 5], [64, 20]]) {
    let resolve;
    const gate = new Promise((done) => resolve = done);
    const streamers = [...Array.from({ length: 24 }, (_, i) => streamer('HUYA', String(i))), streamer('DOUYU', '另一平台')];
    const run = setup(streamers, () => gate, cores);
    const pending = run.exports.run();
    await tick();
    assert.equal(run.calls.length, expected);
    assert.equal(run.calls[1].command, 'fetch_douyu_room_info');
    resolve({ is_live: false });
    await pending;
    assert.equal(run.lock.current, false);
  }
});

test('慢房间不会阻止已完成结果显示，失败保持原状态', async () => {
  let resolve;
  const gate = new Promise((done) => resolve = done);
  const run = setup([streamer('HUYA', '慢'), streamer('DOUYU', '快'), streamer('DOUYU', '失败', 'UNKNOWN')],
    (_command, args) => args.roomId === '慢' ? gate : args.roomId === '失败' ? Promise.reject(new Error('网络错误')) : { show_status: 1 });
  const pending = run.exports.run();
  await tick();
  run.flush();
  assert.equal(run.patches.find((item) => item.id === '快')?.patch.liveStatus, 'LIVE');
  resolve({ is_live: false });
  await pending;
  assert.equal(run.patches.some((item) => item.id === '失败'), false);
});

test('虎牙状态刷新仅取元信息，保留昵称头像和标题', async () => {
  const run = setup([], (_command, args) => {
    assert.equal(args.metadataOnly, true);
    return { is_live: true, nick: '主播', avatar: '头像', title: '标题' };
  });
  const result = await run.exports.refreshOne(streamer('HUYA', '123'));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { nickname: '主播', avatarUrl: '头像', roomTitle: '标题', liveStatus: 'LIVE' });
});

test('刷新期间重复调用不会追加请求，卸载后不再写回结果', async () => {
  let resolve;
  const gate = new Promise((done) => resolve = done);
  const run = setup([streamer('HUYA', '123')], () => gate);
  const pending = run.exports.run();
  await run.exports.run();
  assert.equal(run.calls.length, 1);
  run.aliveRef.current = false;
  resolve({ is_live: true });
  await pending;
  assert.equal(run.patches.length, 0);
});

test('超时旧轮次不覆盖新轮次，也不释放新轮次的刷新锁', async () => {
  const resolvers = [];
  const run = setup([streamer('HUYA', '123')], () => new Promise((resolve) => resolvers.push(resolve)));
  const oldRun = run.exports.run();
  for (const [id, task] of [...run.timers]) if (task.ms > 20_000) {
    run.timers.delete(id);
    task.fn();
  }
  const newRun = run.exports.run();
  resolvers[0]({ is_live: false });
  await oldRun;
  assert.equal(run.lock.current, true);
  assert.equal(run.patches.length, 0);
  resolvers[1]({ is_live: true });
  await newRun;
  assert.equal(run.patches[0].patch.liveStatus, 'LIVE');
  assert.equal(run.lock.current, false);
});


test('五个平台在同次关注查询中保留分类和热度，不增加请求', async () => {
  for (const [platform, response] of [
    ['DOUYU', { show_status: 1 }], ['HUYA', { is_live: true }],
    ['BILIBILI', { status: 1 }], ['DOUYIN', { status: 2 }], ['TWITCH', { is_live: true }],
  ]) {
    const run = setup([], () => ({ ...response, category_name: 'League of Legends', category_id: '9', popularity: 123 }));
    const result = await run.exports.refreshOne(streamer(platform, '1'));
    assert.equal(result.categoryName, 'League of Legends');
    assert.equal(result.categoryId, '9');
    assert.equal(result.popularity, 123);
    assert.equal(result.liveStatus, 'LIVE');
    assert.equal(run.calls.length, 1);
  }
});

test('未开播也提取官方分类并清除运行时热度，分类缺失不覆盖缓存', async () => {
  // 斗鱼 betard / B站 room_info / 虎牙 profileRoom 在主播未开播时同样返回分类字段
  //（真实响应已验证），未开播的有效分类必须更新，同时清除过期热度。
  const run = setup([], () => ({ is_live: false, category_name: '另一个游戏', category_id: '2', popularity: 999 }));
  const result = await run.exports.refreshOne({ ...streamer('HUYA', '1'), categoryName: 'LOL', categoryId: '1', popularity: 88 });
  assert.equal(result.categoryName, '另一个游戏');
  assert.equal(result.categoryId, '2');
  assert.equal(result.popularity, undefined);
  assert.equal(result.liveStatus, 'OFFLINE');

  // 未开播且响应缺分类：不产出分类补丁，merge 层保留旧缓存。
  const run2 = setup([], () => ({ is_live: false }));
  const result2 = await run2.exports.refreshOne({ ...streamer('HUYA', '1'), categoryName: 'LOL', categoryId: '1' });
  assert.equal(result2.categoryName, undefined);
  assert.equal(result2.popularity, undefined);
  assert.equal(result2.liveStatus, 'OFFLINE');
});

test('元信息缺失直播状态不误判为未开播', async () => {
  for (const platform of ['DOUYU', 'HUYA', 'BILIBILI', 'TWITCH']) {
    const run = setup([], () => ({ category_name: 'LOL' }));
    const result = await run.exports.refreshOne(streamer(platform, '1', 'UNKNOWN'));
    assert.equal(result.liveStatus, 'UNKNOWN');
  }
});

test('刷新只写回主播数据，不调用列表重排（游戏分组只是视图）', async () => {
  const run = setup([streamer('HUYA', 'a', 'OFFLINE'), streamer('HUYA', 'b', 'LIVE')], () => ({ is_live: true }));
  await run.exports.run();
  assert.equal(run.patches.length, 1);
  assert.equal(run.patches[0].id, 'a');
});


test('未开播首次刷新五平台均能取官方分类，无旧缓存也可归组', async () => {
  for (const [platform, status] of [
    ['DOUYU', { show_status: 2 }], ['HUYA', { is_live: false }],
    ['BILIBILI', { status: 0 }], ['DOUYIN', { status: 4 }], ['TWITCH', { is_live: false }]
  ]) {
    const run = setup([], () => ({ ...status, category_name: '三角洲行动', category_id: '9', popularity: 999 }));
    const result = await run.exports.refreshOne(streamer(platform, '无缓存'));
    assert.equal(result.categoryName, '三角洲行动');
    assert.equal(result.categoryId, '9');
    assert.equal(result.liveStatus, 'OFFLINE');
    assert.equal(result.popularity, undefined);
    assert.equal(run.calls.length, 1);
  }
});

test('抖音未知状态仍保留有效官方分类而不改写已知直播状态', async () => {
  for (const response of [{ status: null }, { status: 0 }, { error_message: '状态不可确认' }]) {
    const run = setup([streamer('DOUYIN', '123', 'LIVE')], () => ({ ...response, category_name: '英雄联盟', category_id: '1010014,1' }));
    const patch = await run.exports.refreshOne(streamer('DOUYIN', '123', 'LIVE'));
    assert.equal(patch.categoryName, '英雄联盟');
    assert.equal(patch.categoryId, '1010014,1');
    assert.equal(Object.hasOwn(patch, 'liveStatus'), false);
  }
});

test('抖音未知状态且无有效官方分类仍不覆盖缓存或伪装离线', async () => {
  for (const name of ['', '其他', '未知', '0', null]) {
    const run = setup([streamer('DOUYIN', '123', 'LIVE')], () => ({ status: 0, category_name: name }));
    await assert.rejects(run.exports.refreshOne(streamer('DOUYIN', '123', 'LIVE')));
    assert.equal(run.patches.length, 0);
  }
});


test('仅查询未开播和未知关注，五个平台已直播数据完全保持不动，进度只计待发现人数', async () => {
  const live = ['DOUYU','HUYA','BILIBILI','DOUYIN','TWITCH'].map(platform => ({
    ...streamer(platform, platform, 'LIVE'), categoryName: '英雄联盟', popularity: 99
  }));
  const pending = [streamer('DOUYU', '新开播'), streamer('HUYA', '未知', 'UNKNOWN'),
    { ...streamer('TWITCH', '旧数据'), liveStatus: undefined }];
  const originals = JSON.stringify(live);
  const run = setup([...live, ...pending], command => command === 'fetch_douyu_room_info'
    ? { show_status: 1 } : { is_live: true });
  await run.exports.run();
  assert.deepEqual(run.calls.map(c => c.args.roomId ?? c.args.login).sort(), ['新开播','旧数据','未知'].sort());
  assert.equal(run.patches.length, 3);
  assert.ok(run.patches.every(p => p.patch.liveStatus === 'LIVE'));
  assert.equal(run.progress.total, 3);
  assert.equal(run.progress.current, 3);
  assert.equal(run.progress.refreshing, false);
  assert.equal(JSON.stringify(live), originals);
  assert.ok(run.follow.followedStreamers.slice(0,5).every((s,i) => s === live[i]));
});

test('空关注或全部已直播时不发请求、不占刷新锁、不启动看门狗', async () => {
  for (const streamers of [[], [streamer('HUYA','已直播','LIVE')]]) {
    const run = setup(streamers, () => { throw Error('不应查询已直播主播'); });
    await run.exports.run(); await run.exports.run();
    assert.equal(run.calls.length, 0); assert.equal(run.patches.length, 0);
    assert.equal(run.lock.current, false); assert.equal(run.progress.refreshing, false);
    assert.equal(run.timers.size, 0);
  }
});

test('新发现开播后加入直播数据，下一轮只继续查询仍未开播的主播', async () => {
  const run = setup([streamer('DOUYU','新开播'), streamer('HUYA','仍离线')], command =>
    command === 'fetch_douyu_room_info' ? { show_status: 1 } : { is_live: false });
  await run.exports.run();
  // Provider owns immutable updates; feed its committed snapshot into the next invocation.
  run.follow.followedStreamers = run.follow.followedStreamers.map(s => ({ ...s,
    ...run.patches.find(p => p.platform === s.platform && p.id === s.id)?.patch }));
  assert.equal(run.follow.followedStreamers.find(s => s.id === '新开播').liveStatus, 'LIVE');
  run.calls.length = 0; run.patches.length = 0;
  await run.exports.run();
  assert.equal(run.calls.length, 1); assert.equal(run.calls[0].args.roomId, '仍离线');
  assert.equal(run.progress.total, 1); assert.equal(run.progress.current, 1);
});

test('待发现关注查询失败后保留缓存，下次刷新仍会重试并发现开播', async () => {
  let failed = true;
  const cached = { ...streamer('HUYA','重试','UNKNOWN'), categoryName: '英雄联盟', nickname: '缓存昵称' };
  const run = setup([cached], () => failed ? Promise.reject(Error('网络失败')) : { is_live: true, nick: '最新昵称' });
  await run.exports.run(); assert.equal(run.patches.length, 0); assert.equal(run.follow.followedStreamers[0], cached);
  failed = false; await run.exports.run();
  assert.equal(run.calls.length, 2); assert.equal(run.patches[0].patch.liveStatus, 'LIVE');
  assert.equal(run.patches[0].patch.nickname, '最新昵称');
});


test('首次延迟刷新读取最新关注快照，不再查询等待期间已开播的主播', async () => {
  let effect;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
      node.arguments[0]?.getText(tree).includes('consumeInitialAutoRefresh')) effect = node.arguments[0].getText(tree);
    ts.forEachChild(node, find);
  }
  find(tree); assert.ok(effect);
  for (const status of ['LIVE', 'UNKNOWN']) {
    const oldRender = setup([streamer('HUYA','同一个主播','UNKNOWN')], () => ({ is_live: true }));
    const nextRender = setup([streamer('HUYA','同一个主播',status)], () => ({ is_live: true }));
    const refreshListRef = { current: oldRender.exports.run };
    let idle;
    const exports = {};
    vm.runInNewContext(ts.transpileModule('export const attach = '+effect, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText, { exports,
      follow: { ...oldRender.follow, hydrated: true, consumeInitialAutoRefresh: () => true },
      allStreamers: oldRender.follow.followedStreamers, REFRESH_INITIAL_DELAY_MS: 1500,
      ensureProxyStarted: async () => {}, refreshList: oldRender.exports.run, refreshListRef,
      window: { requestIdleCallback(fn) { idle = fn; return 1; }, cancelIdleCallback() {} }
    });
    const dispose = exports.attach();
    // React publishes a new immutable context while the original idle callback is still queued.
    refreshListRef.current = nextRender.exports.run;
    idle(); await tick();
    assert.equal(oldRender.calls.length, 0, '首次延迟回调使用了旧关注快照');
    assert.equal(nextRender.calls.length, status === 'LIVE' ? 0 : 1);
    dispose();
  }
});
