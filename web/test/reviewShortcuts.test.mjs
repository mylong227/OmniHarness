// 变更页键盘评审（A1）：模型层按键解析 + 组件层真实 keydown → 选中移动 / stage / revert / 评论 / 帮助。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。
//
// 断言口径（避免「测了个寂寞」）：
//   · 选中移动：既断言 ReviewCursor 的权威序号（hook 槽位 10），也重渲染断言高亮类名跟着走；
//   · a / r：断言真实 RPC 桩被调用且送的是**选中那一块**的 hunk 文本（不是第一块）；
//   · 输入框内：同一次按键换成 TEXTAREA 目标，RPC 必须一次都不发。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();
const { ReviewKeyboard } = await import('../dist/ui/models/ReviewKeyboard.js');
const { ReviewCursor } = await import('../dist/ui/models/ReviewCursor.js');
const { ChangesTab } = await import('../dist/ui/components/tabs/ChangesTab.js');

/** 三块 hunk 的 git patch（单块不够验「移动」：一移动就夹到 0，测不出位移）。 */
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '@@ -10,3 +10,3 @@',
  ' const c = 1;',
  '-const d = 2;',
  '+const d = 3;',
  '@@ -20,3 +20,3 @@',
  ' const e = 1;',
  '-const f = 2;',
  '+const f = 3;',
  '',
].join('\n');

const FILES = [{ path: 'src/app.ts', status: ' M', additions: 3, deletions: 3 }];

/** hook 槽位（与 ChangesTab 的调用序一一对应）。 */
const H = {
  data: 0,
  error: 1,
  loaded: 2,
  expanded: 3,
  patch: 4,
  patchLoading: 5,
  comments: 6,
  busyAct: 7,
  draft: 8,
  draftText: 9,
  selected: 10,
  help: 11,
};

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/** 构造一次按键事件（默认目标是普通 div，即「不在输入框内」）。 */
function keyPress(key, target) {
  return {
    key,
    target: target ?? { tagName: 'DIV' },
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
  };
}

/**
 * 安装 API / 对话框 / toast 桩并渲染一次已展开文件的 ChangesTab。
 * @param overrides 额外覆盖的 hook 槽位（如 help / selected）
 * @param isGit 是否 git 工作区
 * @returns 渲染产物与调用记录
 */
function setup(overrides = {}, isGit = true) {
  const calls = { stageHunk: [], revertHunk: [], stageFile: [], revertFile: [], confirms: 0 };
  const toasts = [];
  runtime.appContext.api = {
    async listChanges(path) {
      return path === undefined
        ? { source: isGit ? 'git' : 'session', branch: 'main', files: FILES }
        : { source: isGit ? 'git' : 'session', patch: PATCH };
    },
    async stageHunk(path, hunk, isNew) {
      calls.stageHunk.push({ path, hunk, isNew });
      return { ok: true };
    },
    async revertHunk(path, hunk) {
      calls.revertHunk.push({ path, hunk });
      return { ok: true };
    },
    async stageFile(path) {
      calls.stageFile.push(path);
      return { ok: true };
    },
    async revertFile(path) {
      calls.revertFile.push(path);
      return { ok: true };
    },
    async listDiffComments() {
      return { comments: [] };
    },
  };
  runtime.appContext.toast = (m, k) => toasts.push({ m, k });
  runtime.appContext.dialog = {
    async confirm() {
      calls.confirms += 1;
      return true;
    },
    async prompt() {
      return null;
    },
  };
  runtime.reset();
  const vnode = runtime.render(
    ChangesTab,
    {},
    {
      [H.data]: { source: isGit ? 'git' : 'session', branch: 'main', files: FILES },
      [H.error]: null,
      [H.loaded]: true,
      [H.expanded]: 'src/app.ts',
      [H.patch]: PATCH,
      [H.patchLoading]: false,
      [H.comments]: [],
      [H.busyAct]: null,
      [H.draft]: null,
      [H.draftText]: '',
      ...overrides,
    },
  );
  return { vnode, calls, toasts };
}

/** 取键盘评审根节点（data-review-root 标记，避免与内部按钮的 onKeyDown 混淆）。 */
function reviewRoot(vnode) {
  const root = collect(vnode, (n) => n.props['data-review-root'] === '1')[0];
  assert.ok(root, '必须渲染 data-review-root 的键盘评审容器');
  return root;
}

/** 按一次键（真实调用组件挂的 onKeyDown prop）。 */
function press(vnode, key, target) {
  reviewRoot(vnode).props.onKeyDown(keyPress(key, target));
}

/** 当前渲染出的选中块下标（aria-current=true 的块头），无选中返回 -1。 */
function selectedHunk(vnode) {
  // 用 data-hunk-idx 精确定位块头：className 子串匹配会连 `.hunk-header` 一起收进来。
  const heads = collect(vnode, (n) => n.props['data-hunk-idx'] !== undefined);
  return heads.findIndex((h) => h.props['aria-current'] === 'true');
}

// ---- 模型层：按键解析 ----

test('ReviewKeyboard：j/k/↑/↓ 移动，a/r/c/? 各自的语义动作', () => {
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('j')), 'next');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('ArrowDown')), 'next');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('k')), 'prev');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('ArrowUp')), 'prev');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('a')), 'accept');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('r')), 'reject');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('c')), 'comment');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('?')), 'help');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('Escape')), 'dismiss');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('Enter')), 'open');
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('z')), 'none');
});

test('ReviewKeyboard：输入框 / 文本域 / contenteditable 内一律不响应（防边打字边 stage）', () => {
  for (const target of [
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { isContentEditable: true },
  ]) {
    assert.strictEqual(ReviewKeyboard.isTypingTarget(target), true);
    assert.strictEqual(
      ReviewKeyboard.resolve(keyPress('a', target)),
      'none',
      '输入框内 a 必须让位给打字',
    );
  }
  assert.strictEqual(ReviewKeyboard.resolve(keyPress('a', { tagName: 'DIV' })), 'accept');
});

test('ReviewKeyboard：Ctrl/Cmd 组合让位给全局快捷键', () => {
  const e = { ...keyPress('a'), ctrlKey: true };
  assert.strictEqual(ReviewKeyboard.resolve(e), 'none');
  assert.strictEqual(ReviewKeyboard.resolve({ ...keyPress('j'), metaKey: true }), 'none');
});

test('ReviewKeyboard.move：越界夹取不环绕，空数据集归 -1', () => {
  assert.strictEqual(ReviewKeyboard.move(0, 'next', 3), 1);
  assert.strictEqual(ReviewKeyboard.move(2, 'next', 3), 2, '末尾再按 j 停在末尾');
  assert.strictEqual(ReviewKeyboard.move(0, 'prev', 3), 0);
  assert.strictEqual(ReviewKeyboard.move(2, 'first', 3), 0);
  assert.strictEqual(ReviewKeyboard.move(0, 'last', 3), 2);
  assert.strictEqual(ReviewKeyboard.move(-1, 'next', 0), -1);
});

test('ReviewCursor：序号权威副本 + 帮助开关（连按不丢步）', () => {
  const c = new ReviewCursor();
  assert.strictEqual(c.reset(3), 0, '数据集就绪即选中首项');
  assert.strictEqual(c.move('next', 3), 1);
  assert.strictEqual(c.move('next', 3), 2, '连按两次必须走两格');
  assert.strictEqual(c.at(), 2);
  assert.strictEqual(c.toggleHelp(), true);
  assert.strictEqual(c.helpVisible(), true);
  c.closeHelp();
  assert.strictEqual(c.helpVisible(), false);
  assert.strictEqual(c.reset(0), -1);
});

// ---- 组件层：真实按键落到真实 RPC ----

test('ChangesTab：初始即选中首块（键盘空间可见，不必先按一次键）', () => {
  const { vnode } = setup();
  assert.strictEqual(selectedHunk(vnode), 0);
});

test('ChangesTab：j / ArrowDown 把选中推进到下一块，k / ArrowUp 退回（含夹取）', () => {
  const { vnode } = setup();
  press(vnode, 'j');
  assert.strictEqual(runtime.get(H.selected), 1, '权威序号必须前进');
  let next = runtime.render(ChangesTab, {});
  assert.strictEqual(selectedHunk(next), 1, '高亮必须跟着走');

  press(next, 'ArrowDown');
  next = runtime.render(ChangesTab, {});
  assert.strictEqual(selectedHunk(next), 2);

  press(next, 'j');
  next = runtime.render(ChangesTab, {});
  assert.strictEqual(selectedHunk(next), 2, '末尾夹取');

  press(next, 'k');
  next = runtime.render(ChangesTab, {});
  assert.strictEqual(selectedHunk(next), 1);
});

test('ChangesTab：a 对**当前选中块**执行 stage（送的是第二块的 hunk 文本）', async () => {
  const { vnode, calls, toasts } = setup();
  press(vnode, 'j');
  press(vnode, 'a');
  await flush();
  assert.strictEqual(calls.stageHunk.length, 1);
  assert.strictEqual(calls.stageHunk[0].path, 'src/app.ts');
  assert.match(calls.stageHunk[0].hunk, /^@@ -10,3 \+10,3 @@/, '必须送选中块（第二块）的 @@ 头');
  assert.match(calls.stageHunk[0].hunk, /\+const d = 3;/);
  assert.deepEqual(toasts[0], { m: '已 stage 该块', k: 'ok' });
});

test('ChangesTab：r 先确认再 revert 选中块（破坏性操作不静默）', async () => {
  const { vnode, calls, toasts } = setup();
  press(vnode, 'j');
  press(vnode, 'j');
  press(vnode, 'r');
  await flush();
  assert.strictEqual(calls.confirms, 1, '必须先经 DialogService 确认');
  assert.strictEqual(calls.revertHunk.length, 1);
  assert.match(calls.revertHunk[0].hunk, /^@@ -20,3 \+20,3 @@/, '必须送第三块');
  assert.deepEqual(toasts[0], { m: '已还原该块', k: 'ok' });
});

test('ChangesTab：c 在选中块的首个改动行开评论草稿', () => {
  const { vnode } = setup();
  press(vnode, 'j');
  press(vnode, 'c');
  const draft = runtime.get(H.draft);
  assert.deepEqual(
    draft,
    { path: 'src/app.ts', side: 'old', line: 11 },
    '第二块首个改动行 = 旧文件第 11 行',
  );
  const next = runtime.render(ChangesTab, {});
  const boxes = collect(
    next,
    (n) => typeof n.props.className === 'string' && n.props.className.includes('diff-draft'),
  );
  assert.strictEqual(boxes.length, 1, '草稿输入框必须真的渲染出来');
});

test('ChangesTab：输入框（TEXTAREA/INPUT）内按 a / r / c 一律不触发任何动作', async () => {
  const { vnode, calls } = setup();
  press(vnode, 'a', { tagName: 'TEXTAREA' });
  press(vnode, 'r', { tagName: 'INPUT' });
  press(vnode, 'c', { isContentEditable: true });
  press(vnode, 'j', { tagName: 'TEXTAREA' });
  await flush();
  assert.strictEqual(calls.stageHunk.length, 0);
  assert.strictEqual(calls.revertHunk.length, 0);
  assert.strictEqual(calls.confirms, 0);
  assert.strictEqual(runtime.get(H.draft), null, '输入框内不得开评论草稿');
  assert.strictEqual(runtime.get(H.selected), -1, '输入框内不得移动选中');
});

test('ChangesTab：? 开合快捷键帮助，Esc 关闭', () => {
  const { vnode } = setup();
  assert.strictEqual(
    collect(vnode, (n) => n.props['data-review-help'] === '1').length,
    0,
    '默认不展开',
  );
  press(vnode, '?');
  assert.strictEqual(runtime.get(H.help), true);
  let next = runtime.render(ChangesTab, {});
  const help = collect(next, (n) => n.props['data-review-help'] === '1');
  assert.strictEqual(help.length, 1, '按 ? 必须渲染帮助面板');
  assert.strictEqual(help[0].props.role, 'dialog');
  assert.match(String(help[0].props['aria-label']), /快捷键/);

  press(next, '?');
  next = runtime.render(ChangesTab, {});
  assert.strictEqual(
    collect(next, (n) => n.props['data-review-help'] === '1').length,
    0,
    '再按 ? 收起',
  );

  press(next, '?');
  next = runtime.render(ChangesTab, {});
  press(next, 'Escape');
  next = runtime.render(ChangesTab, {});
  assert.strictEqual(
    collect(next, (n) => n.props['data-review-help'] === '1').length,
    0,
    'Esc 必须能关掉帮助',
  );
});

test('ChangesTab：非 git 工作区按键评审不产生任何写操作（fail-closed + 提示）', async () => {
  const { vnode, calls, toasts } = setup({}, false);
  press(vnode, 'a');
  press(vnode, 'r');
  await flush();
  assert.strictEqual(calls.stageHunk.length, 0);
  assert.strictEqual(calls.revertHunk.length, 0);
  assert.strictEqual(calls.confirms, 0);
  assert.match(toasts[0].m, /非 git 工作区/);
  assert.strictEqual(toasts[0].k, 'err');
});

test('ChangesTab：收起态（未展开文件）j/k 在文件清单上移动，Enter 打开选中文件', async () => {
  const calls = { listChanges: 0 };
  const opened = [];
  runtime.appContext.api = {
    async listChanges(path) {
      calls.listChanges += 1;
      if (path !== undefined) opened.push(path);
      return path === undefined
        ? {
            source: 'git',
            files: [
              { path: 'src/a.ts', status: ' M', additions: 1, deletions: 1 },
              { path: 'src/b.ts', status: ' M', additions: 1, deletions: 1 },
            ],
          }
        : { source: 'git', patch: PATCH };
    },
    async listDiffComments() {
      return { comments: [] };
    },
  };
  runtime.reset();
  const vnode = runtime.render(
    ChangesTab,
    {},
    {
      [H.data]: {
        source: 'git',
        files: [
          { path: 'src/a.ts', status: ' M', additions: 1, deletions: 1 },
          { path: 'src/b.ts', status: ' M', additions: 1, deletions: 1 },
        ],
      },
      [H.error]: null,
      [H.loaded]: true,
      [H.expanded]: null,
      [H.patch]: '',
      [H.patchLoading]: false,
      [H.comments]: [],
      [H.busyAct]: null,
      [H.draft]: null,
      [H.draftText]: '',
    },
  );
  assert.strictEqual(selectedHunk(vnode), -1, '未展开时没有改动块可选中');
  press(vnode, 'j');
  assert.strictEqual(runtime.get(H.selected), 1, '文件清单上的选中同样会移动');
  press(vnode, 'Enter');
  await flush();
  assert.deepEqual(opened, ['src/b.ts'], 'Enter 打开的是选中的那个文件');
});
