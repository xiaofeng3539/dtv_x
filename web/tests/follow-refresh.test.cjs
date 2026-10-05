const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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
  let sequence = 0, order;
  const exports = {};
  const aliveRef = { current: true }, lock = { current: false };
  const folder = { type: 'folder', id: '收藏' };
  const context = { exports, console, navigator: { hardwareConcurrency: cores },
    window: { setTimeout: (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout: (id) => timers.delete(id) },
    invoke: async (command, args) => { calls.push({ command, args }); return query(command, args); },
    follow: { followedStreamers: streamers, updateStreamers: (items) => patches.push(...items), updateListOrder: (items) => order = items },
    isRefreshingRef: lock, aliveRef, listItemsRef: { current: [folder, ...streamers.map((data) => ({ type: 'streamer', data }))] },
    setIsRefreshing() {}, setShowCheckIcon() {}, setProgressTotal() {}, setProgressCurrent() {},
    PlatformEnum: { BILIBILI: 'BILIBILI', DOUYIN: 'DOUYIN' } };
  vm.runInNewContext(code, context);
  return { exports, calls, patches, timers, lock, aliveRef, folder, get order() { return order; },
    flush() { for (const [id, task] of [...timers]) if (task.ms === 100) { timers.delete(id); task.fn(); } } };
}
const streamer = (platform, id, liveStatus = 'OFFLINE') => ({ platform, id, liveStatus, nickname: id });
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test('慢房间不会阻止已完成结果显示，失败保持原状态和文件夹', async () => {
  let resolve;
  const gate = new Promise((done) => resolve = done);
  const run = setup([streamer('HUYA', '慢'), streamer('DOUYU', '快'), streamer('DOUYU', '失败', 'LIVE')],
    (_command, args) => args.roomId === '慢' ? gate : args.roomId === '失败' ? Promise.reject(new Error('网络错误')) : { show_status: 1 });
  const pending = run.exports.run();
  await tick();
  run.flush();
  assert.equal(run.patches.find((item) => item.id === '快')?.patch.liveStatus, 'LIVE');
  resolve({ is_live: false });
  await pending;
  assert.equal(run.patches.some((item) => item.id === '失败'), false);
  assert.equal(run.order[0], run.folder);
  assert.deepEqual(Array.from(run.order.slice(1), (item) => item.data.id), ['快', '失败', '慢']);
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
  assert.equal(run.order, undefined);
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
