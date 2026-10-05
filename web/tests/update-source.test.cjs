const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/shell/Navbar.tsx'), 'utf8');
const ast = ts.createSourceFile('Navbar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let result;
  function visit(node) { if (predicate(node)) result = node; ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(result, '应存在本地版本读取或版本弹窗处理器');
  return result;
}

test('启动只读取本地版本，卸载后不写回，不发送更新检查请求', async () => {
  const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
    node.arguments[0]?.getText(ast).includes('loadLocalVersion')).arguments[0].getText(ast);
  for (const disposeEarly of [false, true]) {
    let resolve;
    const values = [];
    const exports = {};
    vm.runInNewContext(ts.transpileModule(`export const attach = ${effect}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText, { exports, getVersion: () => new Promise((done) => resolve = done), setLocalVersion: (value) => values.push(value),
      invoke: () => assert.fail('不应发起更新请求') });
    const dispose = exports.attach();
    if (disposeEarly) dispose();
    resolve('0.2.10');
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(values, disposeEarly ? [] : ['0.2.10']);
    if (!disposeEarly) dispose();
  }
});

test('点击版本按钮只打开本地信息，不检查或下载更新', () => {
  const callback = find((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'openUpdateModal')
    .initializer.arguments[0].getText(ast);
  let opened = false;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(`export const open = ${callback}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText, { exports, updatePhase: 'idle', setUpdateOpen: (value) => opened = value, checkUpdate: () => assert.fail('不应检查更新') });
  exports.open();
  assert.equal(opened, true);
});

test('构建不再注册更新检查和安装命令，界面不保留上游更新入口', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src-tauri/src/main.rs'), 'utf8');
  assert.doesNotMatch(main, /^mod version_check;/m);
  assert.doesNotMatch(main, /version_check::(?:check_version_cmd|download_and_install_cmd)/);
  assert.doesNotMatch(source, /cookie-kangd\/dtv_x\/releases|check_version_cmd|download_and_install_cmd|立即更新|打开下载页/);
});
