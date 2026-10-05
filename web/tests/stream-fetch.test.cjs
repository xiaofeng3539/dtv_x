const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

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
    setTimeout, clearTimeout, URL, localStorage: { getItem: () => null },
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

test('斗鱼保留服务器提供的HTTP协议', async () => {
  let upstream;
  const helper = loadHelper('douyu', async (command, payload) => {
    if (command === 'get_stream_url_with_quality_cmd') return 'http://cdn/live.flv';
    if (command === 'set_stream_url_cmd') upstream = payload.url;
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
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
    if (command === 'set_stream_url_cmd') upstream = payload.url;
    if (command === 'start_proxy') return 'http://127.0.0.1:1234/live.flv';
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
