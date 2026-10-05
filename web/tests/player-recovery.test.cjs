const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// 提取真实错误监听器，避免为了测试网络恢复引入 React 测试框架。
function attachRecovery() {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/player/MainPlayer.tsx'), 'utf8');
  const start = source.indexOf('player.on?.("error",');
  const end = source.indexOf('// 收到 playing', start);
  const body = source.slice(start, end);
  const transpiled = ts.transpileModule(`
    export function attach(player: any, ctx: any) {
      const { sessionId, isSessionActive, reconnectCooldownUntilRef, reconnectDeferredRef,
        scheduleReconnect, playerRef, userPausedRef, playbackFailureTimerRef } = ctx;
      ${body}
    }
  `, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const tasks = new Map();
  let seq = 0;
  vm.runInNewContext(transpiled, { exports, Date, console: { info() {}, warn() {} }, window: {
    setTimeout(callback) { tasks.set(++seq, callback); return seq; },
    clearTimeout(id) { tasks.delete(id); },
  } });
  const video = { currentTime: 10, readyState: 2, paused: false, ended: false, error: null };
  let handler;
  let reconnects = 0;
  const context = {
    sessionId: 1, isSessionActive: () => true,
    reconnectCooldownUntilRef: { current: 0 }, reconnectDeferredRef: { current: false },
    playerRef: { current: { root: { querySelector: () => video } } },
    userPausedRef: { current: false }, playbackFailureTimerRef: { current: null },
    scheduleReconnect: () => reconnects++,
  };
  exports.attach({ on: (_event, callback) => handler = callback }, context);
  return { video, context, error: () => handler({ message: '网络错误' }),
    runTimers: () => { const callbacks = [...tasks.values()]; tasks.clear(); callbacks.forEach((callback) => callback()); },
    get reconnects() { return reconnects; }, get timers() { return tasks.size; },
  };
}

test('错误后画面恢复推进，不打断健康直播', () => {
  const recovery = attachRecovery();
  recovery.error();
  recovery.video.currentTime = 11;
  recovery.runTimers();
  assert.equal(recovery.reconnects, 0);
});

test('同次断流多条错误只安排一次恢复', () => {
  const recovery = attachRecovery();
  recovery.error();
  recovery.error();
  assert.equal(recovery.timers, 1);
  recovery.runTimers();
  assert.equal(recovery.reconnects, 1);
});

test('手动暂停和过期会话不触发重连', () => {
  const recovery = attachRecovery();
  recovery.error();
  recovery.context.userPausedRef.current = true;
  recovery.runTimers();
  assert.equal(recovery.reconnects, 0);
});
