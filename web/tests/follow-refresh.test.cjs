const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

const refreshFile = path.join(__dirname, '../src/state/follow/FollowRefreshProvider.tsx');
const source = fs.readFileSync(fs.existsSync(refreshFile) ? refreshFile : path.join(__dirname, '../src/components/follows/FollowsList.tsx'), 'utf8');
const tree = ts.createSourceFile('follows.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'refreshList') callback = node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
const top = source.slice(source.indexOf('const FOLLOW_REFRESH_CONCURRENCY'), source.indexOf('export function FollowRefreshProvider') > 0 ? source.indexOf('export function FollowRefreshProvider') : source.indexOf('export function FollowsList'));
const code = ts.transpileModule(`${top}\nexport const run = ${callback}; export { refreshOne };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function setup(streamers, query, cores = 2, concurrency = 0) {
  const calls = [], patches = [], timers = new Map();
  let sequence = 0;
  const exports = {};
  const aliveRef = { current: true }, lock = { current: false };
  const progress = { current: 0, total: 0, refreshing: false };
  const context = { exports, console, settings: { followRefreshConcurrency: concurrency }, navigator: { hardwareConcurrency: cores },
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
  assert.equal(run.patches.find((item) => item.id === '失败').patch.liveStatus, 'UNKNOWN');
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
  assert.equal(run.patches.length, 2);
  assert.deepEqual(run.patches.map(p => p.id), ['a', 'b']);
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
    assert.equal(patch.liveStatus, 'UNKNOWN');
  }
});

test('抖音未知状态且无有效官方分类仍不覆盖缓存或伪装离线', async () => {
  for (const name of ['', '其他', '未知', '0', null]) {
    const run = setup([streamer('DOUYIN', '123', 'LIVE')], () => ({ status: 0, category_name: name }));
    await assert.rejects(run.exports.refreshOne(streamer('DOUYIN', '123', 'LIVE')));
    assert.equal(run.patches.length, 0);
  }
});


const grouping = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/state/follow/followGrouping.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, { exports: grouping });
function commitPatches(run) {
  run.follow.followedStreamers = run.follow.followedStreamers.map(s => {
    const patch = run.patches.find(p => p.platform === s.platform && p.id === s.id)?.patch;
    return patch ? grouping.mergeFollowMetadata(s, patch) : s;
  });
}

test('五平台昨天缓存为直播中的主播，今天刷新确认下播并退出直播筛选，保留分类', async () => {
  const cached = ['DOUYU','HUYA','BILIBILI','DOUYIN','TWITCH'].map(platform => ({
    ...streamer(platform, platform, 'LIVE'), categoryName: '英雄联盟', categoryId: 'game', popularity: 99
  }));
  const run = setup(cached, command => ({
    fetch_douyu_room_info: { show_status: 2 }, get_huya_unified_cmd: { is_live: false },
    fetch_bilibili_streamer_info: { status: 0 }, fetch_douyin_streamer_info: { status: 4 },
    get_twitch_streamer_status: { is_live: false }
  })[command]);
  await run.exports.run();
  assert.equal(run.calls.length, 5, '缓存的 LIVE 不应永久跳过状态校验');
  assert.equal(run.patches.length, 5);
  commitPatches(run);
  assert.ok(run.follow.followedStreamers.every(s => s.liveStatus === 'OFFLINE'));
  assert.ok(run.follow.followedStreamers.every(s => s.categoryName === '英雄联盟' && s.categoryId === 'game'));
  assert.ok(run.follow.followedStreamers.every(s => !Object.hasOwn(s, 'popularity')));
  assert.equal(grouping.buildFollowGameGroups(run.follow.followedStreamers, 'ALL', 'LIVE').length, 0);
  assert.equal(grouping.buildFollowGameGroups(run.follow.followedStreamers, 'ALL', 'OFFLINE')[0].members.length, 5);
});

test('直播中、未开播、未知和旧状态均校验，不受当前平台或直播筛选影响', async () => {
  const items = [streamer('HUYA', '正在播', 'LIVE'), streamer('HUYA','刚下播','LIVE'),
    streamer('DOUYU','刚开播'), streamer('TWITCH','未知','UNKNOWN'),
    { ...streamer('TWITCH','旧数据'), liveStatus: undefined }];
  const run = setup(items, (command, args) => command === 'fetch_douyu_room_info'
    ? { show_status: 1 } : { is_live: args.roomId !== '刚下播' });
  run.follow.platformFilter = 'DOUYU'; run.follow.statusFilter = 'LIVE';
  await run.exports.run(); commitPatches(run);
  assert.equal(run.calls.length, 5);
  assert.equal(run.follow.followedStreamers.find(s => s.id === '刚下播').liveStatus, 'OFFLINE');
  assert.equal(run.follow.followedStreamers.find(s => s.id === '刚开播').liveStatus, 'LIVE');
  assert.equal(run.progress.total, 5); assert.equal(run.progress.current, 5);
  assert.equal(run.progress.refreshing, false);
  assert.equal(run.follow.platformFilter, 'DOUYU'); assert.equal(run.follow.statusFilter, 'LIVE');
  assert.deepEqual(run.follow.followedStreamers.map(s => s.id), items.map(s => s.id));
});

test('空关注不发请求、不占刷新锁、不启动看门狗', async () => {
  const run = setup([], () => { throw Error('空关注不应查询'); });
  await run.exports.run(); await run.exports.run();
  assert.equal(run.calls.length, 0); assert.equal(run.patches.length, 0);
  assert.equal(run.lock.current, false); assert.equal(run.progress.refreshing, false);
  assert.equal(run.timers.size, 0);
});

test('全部已直播也能再次校验，下一轮确认下播而不是永久留在直播中', async () => {
  let live = true;
  const run = setup([streamer('HUYA','原本在播','LIVE')], () => ({ is_live: live }));
  await run.exports.run(); commitPatches(run);
  assert.equal(run.follow.followedStreamers[0].liveStatus, 'LIVE');
  run.calls.length = 0; run.patches.length = 0; live = false;
  await run.exports.run(); commitPatches(run);
  assert.equal(run.calls.length, 1);
  assert.equal(run.follow.followedStreamers[0].liveStatus, 'OFFLINE');
});

test('新发现开播后下一轮仍校验，短直播不会卡成永久直播中', async () => {
  let showStatus = 1;
  const run = setup([streamer('DOUYU','短直播'), streamer('HUYA','仍离线')], command =>
    command === 'fetch_douyu_room_info' ? { show_status: showStatus } : { is_live: false });
  await run.exports.run(); commitPatches(run);
  assert.equal(run.follow.followedStreamers.find(s => s.id === '短直播').liveStatus, 'LIVE');
  run.calls.length = 0; run.patches.length = 0; showStatus = 2;
  await run.exports.run(); commitPatches(run);
  assert.equal(run.calls.length, 2);
  assert.equal(run.follow.followedStreamers.find(s => s.id === '短直播').liveStatus, 'OFFLINE');
  assert.equal(run.progress.total, 2); assert.equal(run.progress.current, 2);
});

test('状态查询失败像Simple Live一样回到UNKNOWN而非保留假直播，下次成功可恢复', async () => {
  let failed = true;
  const cached = { ...streamer('HUYA','重试','LIVE'), categoryName: '英雄联盟', nickname: '缓存昵称', popularity: 88 };
  const run = setup([cached], () => failed ? Promise.reject(Error('网络失败')) : { is_live: false, nick: '最新昵称' });
  await run.exports.run(); commitPatches(run);
  assert.equal(run.calls.length, 1); assert.equal(run.patches.length, 1);
  assert.equal(run.follow.followedStreamers[0].liveStatus, 'UNKNOWN');
  assert.equal(run.follow.followedStreamers[0].categoryName, '英雄联盟');
  assert.equal(Object.hasOwn(run.follow.followedStreamers[0], 'popularity'), false);
  run.patches.length = 0;
  failed = false; await run.exports.run(); commitPatches(run);
  assert.equal(run.calls.length, 2); assert.equal(run.follow.followedStreamers[0].liveStatus, 'OFFLINE');
  assert.equal(run.follow.followedStreamers[0].nickname, '最新昵称');
  assert.equal(run.follow.followedStreamers[0].categoryName, '英雄联盟');
  assert.equal(Object.hasOwn(run.follow.followedStreamers[0], 'popularity'), false);
});

test('数据就绪立即首次刷新，不等idle也不继承昨天的状态', async () => {
  let effect;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
      node.arguments[0]?.getText(tree).includes('consumeInitialAutoRefresh')) effect = node.arguments[0].getText(tree);
    ts.forEachChild(node, find);
  }
  find(tree); assert.ok(effect);
  const run = setup([streamer('HUYA','缓存','LIVE')], () => ({ is_live: false }));
  const exports = {};
  vm.runInNewContext(ts.transpileModule('export const attach = '+effect, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, settingsHydrated: true,
    follow: { ...run.follow, hydrated: true, consumeInitialAutoRefresh: () => true },
    allStreamers: run.follow.followedStreamers, REFRESH_INITIAL_DELAY_MS: 1500,
    ensureProxyStarted: async () => {}, refreshListRef: { current: run.exports.run },
    window: { requestIdleCallback() { return 1; }, cancelIdleCallback() {} }
  });
  exports.attach(); await tick(); commitPatches(run);
  assert.equal(run.calls.length, 1, '首次刷新不应等到界面空闲才确认缓存状态');
  assert.equal(run.follow.followedStreamers[0].liveStatus, 'OFFLINE');
});

test('定时轮询调用同一状态校验流程，已直播主播下播后能自动移出直播筛选', async () => {
  let effect;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
      node.arguments[0]?.getText(tree).includes('pollIntervalMs <= 0')) effect = node.arguments[0].getText(tree);
    ts.forEachChild(node, find);
  }
  find(tree); assert.ok(effect);
  const run = setup([streamer('HUYA','轮询前在播','LIVE')], () => ({ is_live: false }));
  const tasks = new Map(); let seq = 0;
  const exports = {};
  vm.runInNewContext(ts.transpileModule('export const attach = '+effect, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, settingsHydrated: true, pollIntervalMs: 60_000, refreshListRef: { current: run.exports.run },
    window: { setTimeout(fn) { tasks.set(++seq,fn); return seq; }, clearTimeout(id) { tasks.delete(id); } }
  });
  const dispose = exports.attach();
  tasks.get(1)(); await tick(); commitPatches(run);
  assert.equal(run.calls.length, 1);
  assert.equal(run.follow.followedStreamers[0].liveStatus, 'OFFLINE');
  assert.equal(grouping.buildFollowGameGroups(run.follow.followedStreamers, 'ALL', 'LIVE').length, 0);
  dispose();
});


test('手动并发数覆盖CPU自动值，固定worker持续取任务', async () => {
  for (const count of [1,4,8,20]) {
    let resolve; const gate = new Promise(done => resolve = done);
    const run = setup(Array.from({length:25},(_,i)=>streamer('HUYA',String(i))),()=>gate,2,count);
    const pending=run.exports.run(); await tick();
    assert.equal(run.calls.length,count); resolve({is_live:false}); await pending;
    assert.equal(run.calls.length,25); assert.equal(run.progress.current,25);
  }
});

test('Simple Live热度为0或缺失时保持未知而非当成已知热度', async () => {
  for (const popularity of [0,null,undefined,-1]) {
    const run=setup([],()=>({is_live:true,popularity}));
    assert.equal((await run.exports.refreshOne(streamer('HUYA','1'))).popularity,undefined);
  }
});

test('虎牙查询错误不能冒充已确认未开播', async () => {
  const run=setup([streamer('HUYA','错误','LIVE')],()=>Promise.reject('主播未开播或获取虎牙房间详情失败'));
  await run.exports.run(); commitPatches(run);
  assert.equal(run.follow.followedStreamers[0].liveStatus,'UNKNOWN');
});

test('像Simple Live一样新开播立即发布，普通状态变更在整轮结束合并发布', async () => {
  let resolve;const gate=new Promise(done=>resolve=done);
  const run=setup([streamer('HUYA','慢'),streamer('HUYA','下播','LIVE')],(_c,args)=>args.roomId==='慢'?gate:{is_live:false});
  const pending=run.exports.run();await tick();run.flush();
  assert.equal(run.patches.length,0,'普通下播应随本轮最终筛选一起发布');
  resolve({is_live:false});await pending;assert.equal(run.patches.length,2);
});
