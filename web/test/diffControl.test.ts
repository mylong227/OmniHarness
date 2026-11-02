// F6 diff accept/reject 闭环：前端接线契约测试。
// 上半：ApiClient 的 stageFile / revertFile / stageHunk / revertHunk 调用正确的 changes.* RPC。
// 下半：ChangesTab 在**真实 React + jsdom** 里跑一遍「点 hunk/stage → 调 RPC → 刷新清单 → 提示」闭环，
// 坐实「hunk / 文件级接受（stage）与拒绝（revert）联动真实写入」在 UI 这一侧也成立。
//
// 迁移（2026-10-18）：旧组件用例用 hook 槽位直接摆"已展开文件 + patch"，并直接调 props.onClick。
// 现在让组件**真的去取**（listChanges）并**真的点**（fireEvent.click 文件行展开 → 点 hunk 按钮），
// 断言仍是同一组 RPC 调用/参数/提示——覆盖的路径比迁移前更长。

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { byClass, facadeOf, walk } from './domFacade.ts';
import type { Facade, FacadeNode } from './domFacade.ts';
import type { ApiClient as ApiClientClass } from '../src/core/ApiClient.ts';

const { ApiClient } = await import('../src/core/ApiClient.ts');
const { ChangesTab } = await import('../src/ui/components/tabs/ChangesTab.tsx');

/** 捕获一次 RPC 调用（method + params）。 */
async function captureRpc(fn: (api: ApiClientClass) => Promise<unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  // Node 环境没有真实 fetch 响应体；返回的最小对象（含 json()）已满足 ApiClient 的用法，
  // 在「测试桩与被测代码的调用边界」按 fetch 签名收窄（规则允许的例外 a）。
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) } as unknown as Response;
  }) as typeof fetch;
  const api = new ApiClient();
  const res = await fn(api);
  const body = JSON.parse(String(calls[0].init.body));
  return { calls, body, res };
}

test('stageFile 调用 changes.stageFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.stageFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.strictEqual(body.method, 'changes.stageFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('revertFile 调用 changes.revertFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.revertFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.strictEqual(body.method, 'changes.revertFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('stageHunk 调用 changes.stageHunk RPC（含 hunk 与 isNew）', async () => {
  const { body, res } = await captureRpc((api) => api.stageHunk('src/app.ts', '@@ -1,3 +1,3 @@', true));
  assert.deepEqual(res, { ok: true });
  assert.strictEqual(body.method, 'changes.stageHunk');
  assert.deepEqual(body.params, { path: 'src/app.ts', hunk: '@@ -1,3 +1,3 @@', isNew: true });
});

test('revertHunk 调用 changes.revertHunk RPC（含 hunk）', async () => {
  const { body, res } = await captureRpc((api) => api.revertHunk('src/app.ts', '@@ -1,3 +1,3 @@'));
  assert.deepEqual(res, { ok: true });
  assert.strictEqual(body.method, 'changes.revertHunk');
  assert.deepEqual(body.params, { path: 'src/app.ts', hunk: '@@ -1,3 +1,3 @@' });
});

// ---- 组件闭环：ChangesTab 真渲染 + 真点击 ----

/** git 工作区的一个含单 hunk 的 patch。 */
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
].join('\n');

const FILES = [{ path: 'src/app.ts', status: ' M', additions: 1, deletions: 1 }];

/** renderChangesTab 的调用记录（RPC 计数 / 参数 / toast）。 */
interface ChangeCalls {
  listChanges: number;
  stageHunk: { path: string; hunk: string; isNew?: boolean }[];
  stageFile: string[];
  revertHunk: { path: string; hunk: string }[];
  revertFile: string[];
  comments: number;
  confirms: number;
}

/** toast 调用记录（文案 + 级别）。 */
interface ToastCall {
  m?: string;
  k?: string;
}

/**
 * 安装 API / 对话框 / toast 桩，渲染 ChangesTab，并**点开文件**等 patch 落地。
 *
 * 迁移说明（2026-10-18）：旧用例用 hook 槽位直接摆"已展开 + patch 已加载"，再直接调用
 * `props.onClick`。真实 React 下这两步都走真实路径：`renderFacadeAsync` 冲掉首次取数，
 * 再 `fireEvent.click` 文件行触发 `openPatch`，`waitFor` 等到 hunk 按钮出现。
 *
 * @param isGit 是否 git 工作区
 * @returns 渲染句柄、调用记录与可覆写的 responses
 */
async function renderChangesTab(isGit = true) {
  const calls: ChangeCalls = {
    listChanges: 0,
    stageHunk: [],
    stageFile: [],
    revertHunk: [],
    revertFile: [],
    comments: 0,
    confirms: 0,
  };
  const toasts: ToastCall[] = [];
  const responses: Record<string, unknown> = {
    async listChanges(path?: string) {
      calls.listChanges += 1;
      return path === undefined
        ? { source: isGit ? 'git' : 'session', branch: isGit ? 'main' : undefined, files: FILES }
        : { source: isGit ? 'git' : 'session', patch: PATCH };
    },
    async stageHunk(path: string, hunk: string, isNew: boolean) {
      calls.stageHunk.push({ path, hunk, isNew });
      return { ok: true };
    },
    async stageFile(path: string) {
      calls.stageFile.push(path);
      return { ok: true };
    },
    async revertHunk(path: string, hunk: string) {
      calls.revertHunk.push({ path, hunk });
      return { ok: true };
    },
    async revertFile(path: string) {
      calls.revertFile.push(path);
      return { ok: true };
    },
    async listDiffComments() {
      calls.comments += 1;
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

  /** 从**同一容器**取当前渲染树（点击会触发重渲染，旧快照会过期）。 */
  const tree = (): Facade => facadeOf(ui.container.firstElementChild);

  const row = byClass(tree(), 'change-row')[0];
  assert.ok(row !== undefined, '必须渲染出变更文件行');
  fireEvent.click(row.el);
  await waitFor(() => {
    // 等 patch 视图出现（`.review` 是 renderChangesPatch 的根；非 git 工作区没有 hunk 按钮，
    // 故不能用按钮存在作为就绪条件）。
    if (byClass(tree(), 'review').length === 0) throw new Error('patch 尚未加载完成');
  });
  return { ui, tree, calls, toasts, responses };
}

/**
 * 取指定 title 片段的 hunk 按钮。
 * @param tree 当前渲染树
 * @param titlePart title 片段
 * @returns 命中的按钮（未命中为 undefined）
 */
function buttonByTitle(tree: Facade, titlePart: string): FacadeNode | undefined {
  return walkCollect(
    tree,
    (n) =>
      typeof n.props.className === 'string' &&
      n.props.className.includes('hunk-btn') &&
      String(n.props.title ?? '').includes(titlePart),
  )[0];
}

/**
 * 深度收集满足谓词的节点。
 * @param node 外观节点
 * @param pred 谓词
 * @returns 命中节点
 */
function walkCollect(node: Facade, pred: (n: FacadeNode) => boolean): FacadeNode[] {
  const out: FacadeNode[] = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

test('ChangesTab：hunk「stage」调 changes.stageHunk（含真实 hunk 文本）并刷新清单 + 成功提示', async () => {
  const { tree, calls, toasts } = await renderChangesTab(true);
  const stageBtn = buttonByTitle(tree(), 'stage 该改动块');
  assert.ok(stageBtn !== undefined, 'git 工作区必须渲染 hunk stage 按钮');

  calls.listChanges = 0;
  fireEvent.click(stageBtn.el);
  await waitFor(() => {
    if (calls.stageHunk.length !== 1 || toasts.length === 0) throw new Error('操作尚未完成');
  });

  assert.strictEqual(calls.stageHunk.length, 1, '必须且只调一次 changes.stageHunk');
  assert.strictEqual(calls.stageHunk[0].path, 'src/app.ts');
  assert.match(calls.stageHunk[0].hunk, /^@@ -1,3 \+1,3 @@/, '送给服务端的必须是完整 hunk（含 @@ 头）');
  assert.match(calls.stageHunk[0].hunk, /\+const b = 3;/);
  assert.strictEqual(calls.stageHunk[0].isNew, false, '已有 @@ 的文件不是新文件');
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已 stage 该块', k: 'ok' });
});

test('ChangesTab：hunk「丢弃」先确认再调 changes.revertHunk 并刷新 + 提示', async () => {
  const { tree, calls, toasts } = await renderChangesTab(true);
  const revertBtn = buttonByTitle(tree(), '丢弃该改动块');
  assert.ok(revertBtn !== undefined, 'git 工作区必须渲染 hunk 丢弃按钮');

  calls.listChanges = 0;
  fireEvent.click(revertBtn.el);
  await waitFor(() => {
    if (calls.revertHunk.length !== 1 || toasts.length === 0) throw new Error('操作尚未完成');
  });

  assert.strictEqual(calls.confirms, 1, '破坏性操作必须先经 DialogService 确认');
  assert.strictEqual(calls.revertHunk.length, 1);
  assert.strictEqual(calls.revertHunk[0].path, 'src/app.ts');
  assert.match(calls.revertHunk[0].hunk, /^@@ -1,3 \+1,3 @@/);
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已还原该块', k: 'ok' });
});

test('ChangesTab：文件级「stage 文件」调 changes.stageFile 并刷新', async () => {
  const { tree, calls, toasts } = await renderChangesTab(true);
  const fileBtn = buttonByTitle(tree(), 'stage 整个文件');
  assert.ok(fileBtn !== undefined, 'git 工作区必须渲染文件级 stage 按钮');

  calls.listChanges = 0;
  fireEvent.click(fileBtn.el);
  await waitFor(() => {
    if (calls.stageFile.length !== 1 || toasts.length === 0) throw new Error('操作尚未完成');
  });

  assert.deepEqual(calls.stageFile, ['src/app.ts']);
  assert.ok(calls.listChanges >= 1);
  assert.deepEqual(toasts[0], { m: '已 stage：src/app.ts', k: 'ok' });
});

test('ChangesTab：非 git 工作区不提供 stage / 丢弃（无真实写入可联动）', async () => {
  const { tree } = await renderChangesTab(false);
  assert.strictEqual(buttonByTitle(tree(), 'stage'), undefined);
  assert.strictEqual(buttonByTitle(tree(), '丢弃'), undefined);
});

test('ChangesTab：操作失败只提示错误、不刷新清单（fail-closed）', async () => {
  const { tree, calls, toasts, responses } = await renderChangesTab(true);
  responses.stageHunk = async () => {
    throw new Error('hunk 不适用');
  };
  const stageBtn = buttonByTitle(tree(), 'stage 该改动块');
  assert.ok(stageBtn !== undefined);
  calls.listChanges = 0;
  fireEvent.click(stageBtn.el);
  await waitFor(() => {
    if (toasts.length === 0) throw new Error('错误提示尚未出现');
  });
  assert.deepEqual(toasts[0], { m: 'hunk 不适用', k: 'err' });
  assert.strictEqual(calls.listChanges, 0, '失败不得假刷新');
});
