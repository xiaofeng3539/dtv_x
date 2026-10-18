const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-api');

test('HLS 实际插件收到直播缓冲和超时配置，而非写到无效的 hls 配置键', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
  const tree = ts.createSourceFile('player.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let branch;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree) === 'isHlsPlayback') branch = node.thenStatement.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(branch);
  const playerOptions = {};
  vm.runInNewContext(ts.transpileModule(branch, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { playerOptions, url: 'https://cdn/live.m3u8', HlsPlugin: {} });
  // xgplayer-hls.js 3.0.26 的接口为 hlsJsPlugin.hlsOpts，已核对实际依赖和官方文档。
  const options = playerOptions.hlsJsPlugin?.hlsOpts;
  assert.ok(options, 'hls.js 配置必须交给实际使用的 HlsJsPlugin');
  assert.ok(options.maxBufferLength > 0 && options.maxBufferLength <= 12);
  assert.ok(options.maxBufferSize <= 20 * 1000 * 1000);
  assert.ok(options.backBufferLength > 0 && options.backBufferLength <= 20);
  assert.ok(options.manifestLoadingTimeOut > 0 && options.manifestLoadingTimeOut <= 10000);
  assert.ok(options.fragLoadingTimeOut > 0 && options.fragLoadingTimeOut <= 15000);
});
