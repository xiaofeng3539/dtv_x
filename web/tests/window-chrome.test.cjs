const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript-api');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Render the actual window-control JSX from both owners, without starting a live stream.
function renderWindowControls(file, isWindows, isMaximized = false) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const branches = [];
  function visit(node) {
    let branch = ts.isConditionalExpression(node) ? node.whenTrue : null;
    while (branch && ts.isParenthesizedExpression(branch)) branch = branch.expression;
    if (branch && ts.isJsxElement(branch)) {
      const label = branch.openingElement.attributes.properties.find(a =>
        ts.isJsxAttribute(a) && a.name.getText(tree) === 'aria-label');
      if (label?.initializer && ['窗口控制', 'Window controls'].includes(label.initializer.text)) {
        branches.push(node.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const exports = {};
  const icon = () => React.createElement('svg');
  const output = ts.transpileModule(`exports.render=()=> <>{[${branches.join(',')}].map((node,index)=>React.createElement(React.Fragment,{key:index},node))}</>`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(output, { exports, React, isWindows, isMaximized,
    styles: new Proxy({}, { get: (_, name) => String(name) }),
    minimizeWindow() {}, toggleMaximizeWindow() {}, closeWindow() {},
    WinCaptionMinimizeIcon: icon, WinCaptionMaximizeIcon: icon,
    WinCaptionRestoreIcon: icon, WinCaptionCloseIcon: icon });
  return renderToStaticMarkup(exports.render());
}

test('主界面和直播页同时存在时只渲染一组窗口按钮', () => {
  const html = renderWindowControls('shell/Navbar.tsx', true) + renderWindowControls('player/MainPlayer.tsx', true);
  assert.equal((html.match(/<button\b/g) || []).length, 3, '窗口按钮重复：主界面和直播页不应各渲染一组');
  assert.equal((html.match(/aria-label="(?:窗口控制|Window controls)"/g) || []).length, 1);
  assert.match(html, /title="最小化"/);
  assert.match(html, /title="最大化"/);
  assert.match(html, /title="关闭"/);
});

test('最大化后仍只有一组还原按钮，非自定义标题栏平台不添加窗口按钮', () => {
  const maximized = renderWindowControls('shell/Navbar.tsx', true, true) + renderWindowControls('player/MainPlayer.tsx', true, true);
  assert.equal((maximized.match(/<button\b/g) || []).length, 3);
  assert.match(maximized, /title="还原"/);
  const nativeCaption = renderWindowControls('shell/Navbar.tsx', false) + renderWindowControls('player/MainPlayer.tsx', false);
  assert.equal(nativeCaption, '');
});

test('打开直播时启用主界面标题栏的播放层级，退出后恢复', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/shell/Navbar.tsx'), 'utf8');
  const tree = ts.createSourceFile('Navbar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let classExpression;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === 'nav') {
      classExpression = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText(tree) === 'className').initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const styles = { navbar: 'nav', navbarDark: 'dark', navbarPlayer: 'player-layer' };
  for (const theme of ['light', 'dark']) {
    for (const isPlayerOpen of [false, true, false]) {
      const classes = vm.runInNewContext(classExpression.getText(tree), { styles, theme, isPlayerOpen }).split(/\s+/);
      assert.equal(classes.includes('player-layer'), isPlayerOpen);
    }
  }
});
