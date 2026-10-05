const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function triggerSearch(query, activePlatform = 'douyu', composing = false, method = 'enter') {
  const file = path.join(__dirname, '../src/components/shell/Navbar.tsx');
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  let clickHandler;
  let submit;
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.text === 'onKeyDown' && node.initializer?.expression?.getText(ast).includes('"Enter"')) handler = node.initializer.expression.getText(ast);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.text === 'aria-label' && attribute.initializer?.text === '搜索')) {
      clickHandler = node.attributes.properties.find((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.text === 'onClick').initializer.expression.getText(ast);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'submitSearch') submit = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  let parseLiveRoomUrl = () => null;
  const parserFile = path.join(__dirname, '../src/services/liveRoomUrl.ts');
  if (fs.existsSync(parserFile)) {
    const parser = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(parserFile, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, { exports: parser, URL });
    parseLiveRoomUrl = parser.parseLiveRoomUrl;
  }
  const calls = [];
  const exports = {};
  const code = `${submit ? `const submitSearch = ${submit};` : ''} export const handle = ${method === 'click' ? clickHandler : handler};`;
  vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, parseLiveRoomUrl, searchQuery: query, activePlatform,
    isPlayerRoute: false, navigateToPlayer: (...args) => calls.push(args),
    setSearchQuery() {}, setSearchResults() {}, setSearchError() {}, setIsSearchFocused() {},
    setPlayerSearchOpen() {}, setIsLoadingSearch() {}, searchInputRef: { current: { blur() {} } },
  });
  exports.handle({ key: 'Enter', nativeEvent: { isComposing: composing }, preventDefault() {} });
  return calls;
}

for (const [platform, link, roomId] of [
  ['bilibili', 'https://live.bilibili.com/12345?spm=1&follow_status=', '12345'],
  ['huya', 'https://www.huya.com/my_room-1?from=search&follow_status=', 'my_room-1'],
  ['douyu', 'https://www.douyu.com/topic/event?rid=5678&follow_status=', '5678'],
  ['douyin', 'https://live.douyin.com/1234567890?from=web&follow_status=', '1234567890'],
  ['douyin', 'https://www.douyin.com/root/live/921169302662?room_id=7689851218365139754', '921169302662'],
]) {
  test(`回车识别${platform}链接，跨平台直接打开正确直播间`, () => {
    assert.deepEqual(triggerSearch(link, 'huya'), [[platform, roomId]]);
  });
  test(`点击搜索识别${platform}链接，跨平台直接打开正确直播间`, () => {
    assert.deepEqual(triggerSearch(link, 'huya', false, 'click'), [[platform, roomId]]);
  });
}

test('普通房间号保留当前平台跳转', () => {
  assert.deepEqual(triggerSearch('12345', 'bilibili'), [['bilibili', '12345']]);
  assert.deepEqual(triggerSearch('12345', 'bilibili', false, 'click'), [['bilibili', '12345']]);
});

test('普通关键词、平台首页、分类和伪装域名不会错误跳转', () => {
  for (const text of ['主播名字', 'https://live.bilibili.com/', 'https://www.huya.com/g/1',
    'https://www.huya.com/search', 'https://www.douyu.com/g_lol',
    'https://live.bilibili.com.evil.test/12345', 'javascript:alert(1)']) {
    assert.deepEqual(triggerSearch(text), []);
    assert.deepEqual(triggerSearch(text, 'douyu', false, 'click'), []);
  }
});

test('输入法确认候选时不触发直播间跳转', () => {
  assert.deepEqual(triggerSearch('12345', 'douyu', true), []);
});
