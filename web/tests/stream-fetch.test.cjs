const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

// 执行真实取流辅助函数，仅替换桌面 IPC；无需启动 WebView。
function loadHelper(platform, invoke) {
  const file = path.join(__dirname, '../src/platforms', platform, 'playerHelper.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const requireMock = (id) => {
    if (id === '@tauri-apps/api/core') return { invoke };
    if (id === '@tauri-apps/api/event') return { listen: async () => () => {} };
    if (id === 'uuid') return { v4: () => 'test' };
    if (id === '@/utils/logger') return { logger: { debug() {}, error() {} } };
    if (id === '../common/types') return { Platform: {} };
    throw new Error(`测试未提供依赖：${id}`);
  };
  vm.runInNewContext(source, {
    exports, require: requireMock, console: { error() {}, warn() {}, debug() {} },
    setTimeout, clearTimeout, URL, window: {}, localStorage: { getItem: () => null },
  }, { filename: file });
  return exports;
}

test('B站接口暂时失败仍会重试，不误判未开播', async () => {
  let calls = 0;
  const helper = loadHelper('bilibili', async () => ++calls === 1
    ? { error_message: '请求超时', status: null }
    : { status: 1, stream_url: 'https://cdn/live.flv' });
  const result = await helper.getBilibiliStreamConfig('1');
  assert.equal(calls, 2);
  assert.equal(result.streamUrl, 'https://cdn/live.flv');
});

test('虎牙房间详情临时失败不当作离线', async () => {
  let calls = 0;
  const helper = loadHelper('huya', async (command) => {
    if (command === 'get_huya_unified_cmd') {
      if (++calls === 1) throw new Error('获取房间详情超时');
      return { is_live: true, selected_url: 'http://cdn/live.flv', flv_tx_urls: [{ quality: '原画', url: 'http://cdn/live.flv' }] };
    }
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
  });
  const result = await helper.getHuyaStreamConfig('1');
  assert.equal(calls, 2);
  assert.ok(result.streamUrl);
});

test('抖音未知状态的接口错误会重试', async () => {
  let calls = 0;
  const helper = loadHelper('douyin', async () => ++calls === 1
    ? { error_message: '网络暂时不可用', status: null }
    : { status: 2, stream_url: 'http://cdn/live.flv' });
  const result = await helper.fetchAndPrepareDouyinStreamConfig('1');
  assert.equal(calls, 2);
  assert.ok(result.streamUrl);
});

test('抖音未知状态保留为未知，不能显示未开播或阻断重连', async () => {
  const helper = loadHelper('douyin', async () => ({ status: 0 }));
  const result = await helper.fetchAndPrepareDouyinStreamConfig('1');
  assert.equal(result.isLive, null);
  assert.doesNotMatch(result.initialError, /未开播|房间不存在/);
});

test('抖音已确认在线但暂时缺少流时仍保留在线状态', async () => {
  const helper = loadHelper('douyin', async () => ({ status: 2, stream_url: null }));
  const result = await helper.fetchAndPrepareDouyinStreamConfig('1');
  assert.equal(result.isLive, true);
  assert.match(result.initialError, /获取直播流失败/);
});

test('播放器顶栏区分直播、关播与未知状态，加载时优先显示加载中', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
  const expression = source.match(/\{(isLoadingStream \? "加载中"[^\n]+)\}/)?.[1];
  assert.ok(expression);
  for (const [playerIsLive, expected] of [[true, '直播中'], [false, '未开播'], [null, '状态未知']]) {
    assert.equal(vm.runInNewContext(expression, { isLoadingStream: false, playerIsLive }), expected);
    assert.equal(vm.runInNewContext(expression, { isLoadingStream: true, playerIsLive }), '加载中');
  }
});

test('斗鱼保留服务器提供的HTTP协议', async () => {
  let upstream;
  const helper = loadHelper('douyu', async (command, payload) => {
    if (command === 'get_stream_url_with_quality_cmd') return 'http://cdn/live.flv';
    if (command === 'start_proxy') {
      upstream = payload?.url;
      return 'http://127.0.0.1:1234/live.flv';
    }
  });
  await helper.getDouyuStreamConfig('1');
  assert.equal(upstream, 'http://cdn/live.flv');
});

test('明确未开播只请求一次', async () => {
  let calls = 0;
  const helper = loadHelper('bilibili', async () => {
    calls++;
    return { status: 0, stream_url: null };
  });
  await assert.rejects(() => helper.getBilibiliStreamConfig('1'), /未开播/);
  assert.equal(calls, 1);
});

test('抖音备用HLS使用HLS内核并保留原始协议', async () => {
  const helper = loadHelper('douyin', async () => ({
    status: 2, stream_url: 'http://cdn/live.flv',
    available_streams: [
      { url: 'http://cdn/live.flv', format: 'flv' },
      { url: 'http://backup/live.m3u8?token=x', format: 'hls' },
    ],
  }));
  const result = await helper.fetchAndPrepareDouyinStreamConfig('1', '原画', 1);
  assert.equal(result.streamType, 'hls');
  assert.equal(result.streamUrl, 'http://backup/live.m3u8?token=x');
  assert.equal(result.candidateCount, 2);
});

test('虎牙使用选中画质备用地址，不退回首条CDN', async () => {
  let upstream;
  const helper = loadHelper('huya', async (command, payload) => {
    if (command === 'get_huya_unified_cmd') return {
      is_live: true, selected_url: 'http://first/live.flv?ratio=4000',
      candidate_urls: ['http://first/live.flv?ratio=4000', 'http://backup/live.flv?ratio=4000'],
      flv_tx_urls: [],
    };
    if (command === 'start_proxy') { upstream = payload?.url; return 'http://127.0.0.1:1234/live.flv'; }
  });
  const result = await helper.getHuyaStreamConfig('1', '高清', 'tx', 1);
  assert.equal(upstream, 'http://backup/live.flv?ratio=4000');
  assert.equal(result.candidateCount, 2);
});

test('B站重连传递备用索引，保留Rust字符串错误原因', async () => {
  let payload;
  let calls = 0;
  const helper = loadHelper('bilibili', async (_command, args) => {
    payload = args;
    calls++;
    throw '网络请求超时';
  });
  await assert.rejects(() => helper.getBilibiliStreamConfig('1', '高清', undefined, 2), /网络请求超时/);
  assert.equal(calls, 2);
  assert.equal(payload.line, 2);
});

test('Twitch 本地代理首次失败或空响应，后续进房允许重新初始化', async () => {
  for (const first of [null, new Error('启动暂时失败')]) {
    let starts = 0;
    const helper = loadHelper('twitch', async (command) => {
      if (command === 'get_twitch_stream_cmd') return {
        selected_url: 'https://cdn/live.m3u8', stream_type: 'hls', qualities: [], is_live: true,
      };
      if (command === 'start_static_proxy_server') {
        if (++starts === 1) {
          if (first instanceof Error) throw first;
          return first;
        }
        return 'http://127.0.0.1:1234';
      }
      throw new Error(command);
    });
    await helper.getTwitchStreamConfig('channel');
    const recovered = await helper.getTwitchStreamConfig('channel');
    assert.equal(starts, 2);
    assert.equal(recovered.streamUrl, 'http://127.0.0.1:1234/hls?url=https%3A%2F%2Fcdn%2Flive.m3u8');
  }
});

test('原生斗鱼直接交给 libmpv，不再启动 WebView 代理',async()=>{
 const calls=[];const helper=loadHelper('douyu',async(command)=>{calls.push(command);if(command==='get_stream_url_with_quality_cmd')return 'https://cdn.example/live.flv';throw Error('unexpected proxy');});
 const result=await helper.getDouyuStreamConfig('1','原画',null,0,true);assert.equal(result.streamUrl,'https://cdn.example/live.flv');assert.deepEqual(calls,['get_stream_url_with_quality_cmd']);
});
test('原生虎牙保留候选地址且不启动代理',async()=>{
 const helper=loadHelper('huya',async(command)=>{assert.equal(command,'get_huya_unified_cmd');return {is_live:true,flv_tx_urls:[{url:'https://cdn.example/a.flv'}],candidate_urls:['https://cdn.example/a.flv','https://cdn.example/b.flv']};});
 const result=await helper.getHuyaStreamConfig('1','原画',null,1,true);assert.equal(result.streamUrl,'https://cdn.example/b.flv');assert.equal(result.candidateCount,2);
});
test('原生 B站同次元数据请求直接取上游，不为播放再开代理',async()=>{
 const helper=loadHelper('bilibili',async(command,args)=>{assert.equal(command,'get_bilibili_live_stream_url_with_quality');assert.equal(args.nativePlayback,true);return {status:1,stream_url:'https://cdn.example/live.flv',upstream_url:'https://cdn.example/live.flv'};});
 assert.equal((await helper.getBilibiliStreamConfig('1','原画',undefined,0,true)).streamUrl,'https://cdn.example/live.flv');
});
test('原生 Twitch 保留现有选画质查询，HLS 直接交给 libmpv',async()=>{
 const calls=[];const helper=loadHelper('twitch',async(command)=>{calls.push(command);if(command==='get_twitch_stream_cmd')return {selected_url:'https://edge.example/live.m3u8',is_live:true};throw Error('unexpected proxy');});
 assert.equal((await helper.getTwitchStreamConfig('one',null,true)).streamUrl,'https://edge.example/live.m3u8');assert.deepEqual(calls,['get_twitch_stream_cmd']);
});

test('原生 B站备用线路复用同次有效响应，不再重复读取房间详情',async()=>{
 let calls=0;const helper=loadHelper('bilibili',async()=>{calls++;return {status:1,stream_url:'https://one/live.flv',available_streams:[{url:'https://one/live.flv'},{url:'https://two/live.flv'}]};});
 await helper.getBilibiliStreamConfig('1','原画',undefined,0,true);const next=await helper.getBilibiliStreamConfig('1','原画',undefined,1,true);assert.equal(next.streamUrl,'https://two/live.flv');assert.equal(calls,1);
});
test('原生虎牙备用线路复用同画质有效响应',async()=>{
 let calls=0;const helper=loadHelper('huya',async()=>{calls++;return {is_live:true,flv_tx_urls:[{url:'https://one/live.flv'}],candidate_urls:['https://one/live.flv','https://two/live.flv']};});
 await helper.getHuyaStreamConfig('1','原画',null,0,true);assert.equal((await helper.getHuyaStreamConfig('1','原画',null,1,true)).streamUrl,'https://two/live.flv');assert.equal(calls,1);
});
test('原生抖音备用线路复用响应，用户刷新仍重新查询',async()=>{
 let calls=0;const helper=loadHelper('douyin',async()=>{calls++;return {status:2,stream_url:'https://one/live.flv',available_streams:[{url:'https://one/live.flv'},{url:'https://two/live.flv'}]};});
 await helper.fetchAndPrepareDouyinStreamConfig('1','原画',0,true);assert.equal((await helper.fetchAndPrepareDouyinStreamConfig('1','原画',1,true)).streamUrl,'https://two/live.flv');assert.equal(calls,1);
 await helper.fetchAndPrepareDouyinStreamConfig('1','原画',0,true);assert.equal(calls,2);
});
