// F6 diff accept/reject 闭环：前端接线契约测试。
// 上半：ApiClient 的 stageFile / revertFile / stageHunk / revertHunk 调用正确的 changes.* RPC。
// 下半：ChangesTab 在零 DOM 桩里真跑一遍「点 hunk/stage → 调 RPC → 刷新清单 → 提示」闭环，
// 坐实「hunk / 文件级接受（stage）与拒绝（revert）联动真实写入」在 UI 这一侧也成立。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRuntime } from './hooksStub.ts';
import type { StubVnode } from './hooksStub.ts';
import type { ApiClient as ApiClientClass } from '../src/core/ApiClient.ts';

const { ApiClient } = await import('../src/core/ApiClient.ts');

// ChangesTab 走 useApp()（React.createContext）与 deps.js，先种运行时桩再动态加载组件。
const runtime = createRuntime();
runtime.install();
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

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
function collect(vnode: unknown, pred: (n: StubVnode) => boolean, out: StubVnode[] = []): StubVnode[] {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  // 遍历的是渲染树（vnode / 文本 / 数组的混合），能走到这里必是对象节点；
  // 具体是不是 StubVnode 由调用方的谓词保证，故收窄一次。
  const node = vnode as StubVnode;
  if (pred(node)) out.push(node);
  collect(node.children, pred, out);
  return out;
}

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
 * 安装 API / 对话框 / toast 桩并渲染一次已展开文件的 ChangesTab。
 * @param isGit 是否 git 工作区
 * @returns 渲染产物、调用记录与 api 桩引用
 */
function renderChangesTab(isGit = true) {
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
  // 桩 api 需带上 StubAppContext.api 的 4 个基础方法（赋值目标形状如此），
  // 再叠加 ChangesTab 真实用到的变更方法（签名对齐 src ApiClient）。
  const api = {
    getConfig: async () => ({}),
    updateConfig: async () => ({}),
    listSessions: async () => [],
    rpc: async () => ({}),
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
  runtime.appContext.api = api;
  runtime.appContext.toast = (m?: string, k?: string) => {
    toasts.push({ m, k });
  };
  runtime.appContext.dialog = {
    async confirm() {
      calls.confirms += 1;
      return true;
    },
    async prompt() {
      return null;
    },
  };
  // hook 槽位：0=data 1=error 2=loaded 3=expanded 4=patch 5=patchLoading
  //            6=comments 7=busyAct 8=draft 9=draftText
  runtime.reset();
  const vnode = runtime.render(
    ChangesTab,
    {},
    {
      0: { source: isGit ? 'git' : 'session', branch: isGit ? 'main' : undefined, files: FILES },
      1: null,
      2: true,
      3: 'src/app.ts',
      4: PATCH,
      5: false,
      6: [],
      7: null,
      8: null,
      9: '',
    },
  );
  return { vnode, calls, toasts, api };
}

/** 取指定 title 片段的按钮。 */
function buttonByTitle(vnode: unknown, titlePart: string): StubVnode | null {
  const btn = collect(
    vnode,
    (n) =>
      typeof n.props.className === 'string' &&
      n.props.className.includes('hunk-btn') &&
      String(n.props.title ?? '').includes(titlePart),
  )[0];
  return btn ?? null;
}

test('ChangesTab：hunk「stage」调 changes.stageHunk（含真实 hunk 文本）并刷新清单 + 成功提示', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const stageBtn = buttonByTitle(vnode, 'stage 该改动块');
  assert.ok(stageBtn, 'git 工作区必须渲染 hunk stage 按钮');

  calls.listChanges = 0;
  // props 值在桩类型里是 unknown；运行时这里确定是 onClick 回调，收窄后调用。
  (stageBtn.props.onClick as () => void)();
  await flush();

  assert.strictEqual(calls.stageHunk.length, 1, '必须且只调一次 changes.stageHunk');
  assert.strictEqual(calls.stageHunk[0].path, 'src/app.ts');
  assert.match(calls.stageHunk[0].hunk, /^@@ -1,3 \+1,3 @@/, '送给服务端的必须是完整 hunk（含 @@ 头）');
  assert.match(calls.stageHunk[0].hunk, /\+const b = 3;/);
  assert.strictEqual(calls.stageHunk[0].isNew, false, '已有 @@ 的文件不是新文件');
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已 stage 该块', k: 'ok' });
});

test('ChangesTab：hunk「丢弃」先确认再调 changes.revertHunk 并刷新 + 提示', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const revertBtn = buttonByTitle(vnode, '丢弃该改动块');
  assert.ok(revertBtn, 'git 工作区必须渲染 hunk 丢弃按钮');

  calls.listChanges = 0;
  // 同上：运行时确定是 onClick 回调。
  (revertBtn.props.onClick as () => void)();
  await flush();

  assert.strictEqual(calls.confirms, 1, '破坏性操作必须先经 DialogService 确认');
  assert.strictEqual(calls.revertHunk.length, 1);
  assert.strictEqual(calls.revertHunk[0].path, 'src/app.ts');
  assert.match(calls.revertHunk[0].hunk, /^@@ -1,3 \+1,3 @@/);
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已还原该块', k: 'ok' });
});

test('ChangesTab：文件级「stage 文件」调 changes.stageFile 并刷新', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const fileBtn = buttonByTitle(vnode, 'stage 整个文件');
  assert.ok(fileBtn, 'git 工作区必须渲染文件级 stage 按钮');

  calls.listChanges = 0;
  // 同上：运行时确定是 onClick 回调。
  (fileBtn.props.onClick as () => void)();
  await flush();

  assert.deepEqual(calls.stageFile, ['src/app.ts']);
  assert.ok(calls.listChanges >= 1);
  assert.deepEqual(toasts[0], { m: '已 stage：src/app.ts', k: 'ok' });
});

test('ChangesTab：非 git 工作区不提供 stage / 丢弃（无真实写入可联动）', () => {
  const { vnode } = renderChangesTab(false);
  assert.strictEqual(buttonByTitle(vnode, 'stage'), null);
  assert.strictEqual(buttonByTitle(vnode, '丢弃'), null);
});

test('ChangesTab：操作失败只提示错误、不刷新清单（fail-closed）', async () => {
  // 经 renderChangesTab 返回的 api 桩引用覆写 stageHunk（与 runtime.appContext.api 是同一对象）。
  const { vnode, calls, toasts, api } = renderChangesTab(true);
  api.stageHunk = async () => {
    throw new Error('hunk 不适用');
  };
  const stageBtn = buttonByTitle(vnode, 'stage 该改动块');
  calls.listChanges = 0;
  // 同上：运行时确定是 onClick 回调。
  (stageBtn!.props.onClick as () => void)();
  await flush();
  assert.deepEqual(toasts[0], { m: 'hunk 不适用', k: 'err' });
  assert.strictEqual(calls.listChanges, 0, '失败不得假刷新');
});
