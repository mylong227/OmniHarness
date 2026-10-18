// 变更页键盘评审（A1）：模型层按键解析 + 组件层真实 keydown → 选中移动 / stage / revert / 评论 / 帮助。
//
// 断言口径（避免「测了个寂寞」）：
//   · 选中移动：断言渲染出的高亮块头（`aria-current=true` / 文件行 `selected`）真的跟着走；
//   · a / r：断言真实 RPC 桩被调用且送的是**选中那一块**的 hunk 文本（不是第一块）；
//   · 输入框内：把按键派发到真实 TEXTAREA / INPUT / contenteditable 目标上，RPC 必须一次都不发。
//
// 迁移（2026-10-18）：旧用例用 hook 槽位摆"已展开 + patch"，再直接调 props.onKeyDown。
// 现在组件真的取数、真的展开，按键走 `fireEvent.keyDown`（React 的真实事件系统）。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText, byClass, byTag, facadeOf } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';
import type { ReviewKeyLike, ReviewTargetLike } from '../src/ui/models/ReviewKeyboard.ts';

const { ReviewKeyboard } = await import('../src/ui/models/ReviewKeyboard.ts');
const { ReviewCursor } = await import('../src/ui/models/ReviewCursor.ts');
const { ChangesTab } = await import('../src/ui/components/tabs/ChangesTab.tsx');

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

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 构造一次按键事件（模型层测试用）。
 * @param key 按键
 * @param target 事件目标（缺省普通 div）
 * @returns ReviewKeyLike
 */
function keyPress(key: string, target?: ReviewTargetLike): ReviewKeyLike & { preventDefault(): void } {
  return {
    key,
    target: target ?? { tagName: 'DIV' },
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
  };
}

/** 变更操作的调用记录（RPC 参数 / 确认次数）。 */
interface ReviewCalls {
  stageHunk: { path: string; hunk: string; isNew?: boolean }[];
  revertHunk: { path: string; hunk: string }[];
  stageFile: string[];
  revertFile: string[];
  addDiffComment: { path: string; side: string; line: number; text: string }[];
  opened: string[];
  confirms: number;
}

/** toast 调用记录（文案 + 级别）。 */
interface ToastCall {
  m?: string;
  k?: string;
}

/**
 * 安装 API / 对话框 / toast 桩，渲染 ChangesTab。
 *
 * @param options.isGit 是否 git 工作区
 * @param options.expand 是否点开文件（true 时等 patch 加载完）
 * @param options.files 变更清单（收起态用例用两个文件）
 * @returns 渲染句柄与调用记录
 */
async function setup(options: { isGit?: boolean; expand?: boolean; files?: unknown[] } = {}) {
  const isGit = options.isGit ?? true;
  const files = options.files ?? FILES;
  const calls: ReviewCalls = {
    stageHunk: [],
    revertHunk: [],
    stageFile: [],
    revertFile: [],
    addDiffComment: [],
    opened: [],
    confirms: 0,
  };
  const toasts: ToastCall[] = [];
  const responses: Record<string, unknown> = {
    async listChanges(path?: string) {
      if (path === undefined) {
        return { source: isGit ? 'git' : 'session', branch: 'main', files };
      }
      calls.opened.push(path);
      return { source: isGit ? 'git' : 'session', patch: PATCH };
    },
    async stageHunk(path: string, hunk: string, isNew: boolean) {
      calls.stageHunk.push({ path, hunk, isNew });
      return { ok: true };
    },
    async revertHunk(path: string, hunk: string) {
      calls.revertHunk.push({ path, hunk });
      return { ok: true };
    },
    async stageFile(path: string) {
      calls.stageFile.push(path);
      return { ok: true };
    },
    async revertFile(path: string) {
      calls.revertFile.push(path);
      return { ok: true };
    },
    async addDiffComment(path: string, side: string, line: number, text: string) {
      calls.addDiffComment.push({ path, side, line, text });
      return { ok: true };
    },
    async listDiffComments() {
      return { comments: [] };
    },
  };
  const ui = await renderFacadeAsync(ChangesTab, {
    props: {},
    responses,
    onToast: (m, k) => toasts.push({ m, k }),
    app: {
      dialog: {
        async confirm() {
          calls.confirms += 1;
          return true;
        },
        async prompt() {
          return null;
        },
      },
    },
  });
  /** 从同一容器取当前渲染树（按键会重渲染）。 */
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);

  if (options.expand !== false) {
    const row = byClass(tree(), 'change-row')[0];
    assert.ok(row !== undefined, '必须渲染改动的文件行');
    fireEvent.click(row.el);
    await waitFor(() => {
      if (byClass(tree(), 'review').length === 0) throw new Error('patch 尚未加载完成');
    });
  }
  return { ui, tree, calls, toasts, responses };
}

/** 取键盘评审根节点（`data-review-root` 标记，避免与内部控件的 keydown 混淆）。 */
function reviewRoot(tree: Facade): FacadeNode {
  const root = byTag(tree, 'div').find((n) => n.props['data-review-root'] === '1');
  assert.ok(root !== undefined, '必须渲染 data-review-root 的键盘评审容器');
  return root;
}

/**
 * 按一次键（真实 `keydown`，目标默认为评审根节点）。
 * @param tree 当前渲染树
 * @param key 按键
 * @param target 事件目标（缺省评审根）
 * @returns 无
 */
function press(tree: Facade, key: string, target?: Element): void {
  fireEvent.keyDown(target ?? reviewRoot(tree).el, { key });
}

/** 当前渲染出的选中块下标（aria-current=true 的块头），无选中返回 -1。 */
function selectedHunk(tree: Facade): number {
  const heads = byTag(tree, 'div').filter((n) => n.props['data-hunk-idx'] !== undefined);
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

test('ChangesTab：初始即选中首块（键盘空间可见，不必先按一次键）', async () => {
  const { tree } = await setup();
  assert.strictEqual(selectedHunk(tree()), 0);
});

test('ChangesTab：j / ArrowDown 把选中推进到下一块，k / ArrowUp 退回（含夹取）', async () => {
  const { tree } = await setup();
  press(tree(), 'j');
  assert.strictEqual(selectedHunk(tree()), 1, '高亮必须跟着走');

  press(tree(), 'ArrowDown');
  assert.strictEqual(selectedHunk(tree()), 2);

  press(tree(), 'j');
  assert.strictEqual(selectedHunk(tree()), 2, '末尾夹取');

  press(tree(), 'k');
  assert.strictEqual(selectedHunk(tree()), 1);
});

test('ChangesTab：a 对**当前选中块**执行 stage（送的是第二块的 hunk 文本）', async () => {
  const { tree, calls, toasts } = await setup();
  press(tree(), 'j');
  press(tree(), 'a');
  await waitFor(() => {
    if (calls.stageHunk.length !== 1 || toasts.length === 0) throw new Error('stage 尚未完成');
  });
  assert.strictEqual(calls.stageHunk.length, 1);
  assert.strictEqual(calls.stageHunk[0]!.path, 'src/app.ts');
  assert.match(calls.stageHunk[0]!.hunk, /^@@ -10,3 \+10,3 @@/, '必须送选中块（第二块）的 @@ 头');
  assert.match(calls.stageHunk[0]!.hunk, /\+const d = 3;/);
  assert.deepEqual(toasts[0], { m: '已 stage 该块', k: 'ok' });
});

test('ChangesTab：r 先确认再 revert 选中块（破坏性操作不静默）', async () => {
  const { tree, calls, toasts } = await setup();
  press(tree(), 'j');
  press(tree(), 'j');
  press(tree(), 'r');
  await waitFor(() => {
    if (calls.revertHunk.length !== 1 || toasts.length === 0) throw new Error('revert 尚未完成');
  });
  assert.strictEqual(calls.confirms, 1, '必须先经 DialogService 确认');
  assert.strictEqual(calls.revertHunk.length, 1);
  assert.match(calls.revertHunk[0]!.hunk, /^@@ -20,3 \+20,3 @@/, '必须送第三块');
  assert.deepEqual(toasts[0], { m: '已还原该块', k: 'ok' });
});

test('ChangesTab：c 在选中块的首个改动行开评论草稿，保存时送对该行号', async () => {
  const { tree, calls } = await setup();
  press(tree(), 'j');
  press(tree(), 'c');
  const boxes = byClass(tree(), 'diff-draft');
  assert.strictEqual(boxes.length, 1, '草稿输入框必须真的渲染出来');
  const textarea = byTag(tree(), 'textarea')[0];
  assert.ok(textarea !== undefined);
  assert.strictEqual(textarea.props['aria-label'], '行内评论内容');

  // 保存走真实输入 → 断言回传的锚点就是「第二块首个改动行 = 旧文件第 11 行」。
  const user = userEvent.setup();
  await user.type(textarea.el as HTMLElement, '这里要改');
  const save = byTag(tree(), 'button').find((b) => allText(b) === '保存');
  assert.ok(save !== undefined, '草稿必须有保存按钮');
  fireEvent.click(save.el);
  await waitFor(() => {
    if (calls.addDiffComment.length !== 1) throw new Error('评论尚未保存');
  });
  assert.deepEqual(calls.addDiffComment[0], {
    path: 'src/app.ts',
    side: 'old',
    line: 11,
    text: '这里要改',
  });
});

test('ChangesTab：输入框 / 文本域 / contenteditable 内按 a / r / c 一律不触发任何动作', async () => {
  const { tree, calls } = await setup();
  const root = reviewRoot(tree());

  /**
   * 在评审根内临时插入一个真实控件并派发按键（事件会冒泡到组件的 onKeyDown）。
   * @param el 控件元素
   * @param key 按键
   */
  const pressOn = (el: HTMLElement, key: string): void => {
    root.el.appendChild(el);
    try {
      fireEvent.keyDown(el, { key });
    } finally {
      el.remove();
    }
  };

  const textarea = document.createElement('textarea');
  pressOn(textarea, 'a');
  pressOn(textarea, 'j');

  const input = document.createElement('input');
  pressOn(input, 'r');

  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  // jsdom 未实现 `isContentEditable`（恒 false），组件按该属性判断"在打字"。
  // 这里把被测代码真正读取的属性显式补上，模拟浏览器里 contenteditable 元素的形态。
  Object.defineProperty(editable, 'isContentEditable', { value: true });
  pressOn(editable, 'c');

  await flush();
  assert.strictEqual(calls.stageHunk.length, 0);
  assert.strictEqual(calls.revertHunk.length, 0);
  assert.strictEqual(calls.confirms, 0);
  assert.strictEqual(byClass(tree(), 'diff-draft').length, 0, '输入框内不得开评论草稿');
  assert.strictEqual(selectedHunk(tree()), 0, '输入框内不得移动选中');
});

test('ChangesTab：? 开合快捷键帮助，Esc 关闭', async () => {
  const { tree } = await setup();
  assert.strictEqual(
    byTag(tree(), 'div').filter((n) => n.props['data-review-help'] === '1').length,
    0,
    '默认不展开',
  );
  press(tree(), '?');
  const help = byTag(tree(), 'div').filter((n) => n.props['data-review-help'] === '1');
  assert.strictEqual(help.length, 1, '按 ? 必须渲染帮助面板');
  assert.strictEqual(help[0]!.props.role, 'dialog');
  assert.match(String(help[0]!.props['aria-label']), /快捷键/);

  press(tree(), '?');
  assert.strictEqual(
    byTag(tree(), 'div').filter((n) => n.props['data-review-help'] === '1').length,
    0,
    '再按 ? 收起',
  );

  press(tree(), '?');
  press(tree(), 'Escape');
  assert.strictEqual(
    byTag(tree(), 'div').filter((n) => n.props['data-review-help'] === '1').length,
    0,
    'Esc 必须能关掉帮助',
  );
});

test('ChangesTab：非 git 工作区按键评审不产生任何写操作（fail-closed + 提示）', async () => {
  const { tree, calls, toasts } = await setup({ isGit: false });
  press(tree(), 'a');
  press(tree(), 'r');
  await waitFor(() => {
    if (toasts.length === 0) throw new Error('尚未给出提示');
  });
  assert.strictEqual(calls.stageHunk.length, 0);
  assert.strictEqual(calls.revertHunk.length, 0);
  assert.strictEqual(calls.confirms, 0);
  assert.match(toasts[0]!.m!, /非 git 工作区/);
  assert.strictEqual(toasts[0]!.k, 'err');
});

test('ChangesTab：收起态（未展开文件）j/k 在文件清单上移动，Enter 打开选中文件', async () => {
  const files = [
    { path: 'src/a.ts', status: ' M', additions: 1, deletions: 1 },
    { path: 'src/b.ts', status: ' M', additions: 1, deletions: 1 },
  ];
  const { tree, calls } = await setup({ expand: false, files });
  assert.strictEqual(selectedHunk(tree()), -1, '未展开时没有改动块可选中');

  press(tree(), 'j');
  const rows = byClass(tree(), 'change-item');
  const selectedRows = rows.filter((r) => clsOf(r).includes('selected'));
  assert.strictEqual(selectedRows.length, 1, '文件清单上的选中同样会移动');
  assert.match(allText(selectedRows[0]!), /src\/b\.ts/, '应选中第二个文件');

  press(tree(), 'Enter');
  await waitFor(() => {
    if (!calls.opened.includes('src/b.ts')) throw new Error('尚未打开选中文件');
  });
  assert.deepEqual(calls.opened, ['src/b.ts'], 'Enter 打开的是选中的那个文件');
});

/** 取 className（与 domFacade.clsOf 同语义；本文件只在“文件行选中态”处用到）。 */
function clsOf(n: FacadeNode): string {
  const v = n.props['className'];
  return typeof v === 'string' ? v : '';
}
