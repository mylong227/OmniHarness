// F6 diff accept/reject 闭环：前端接线契约测试。
// 上半：ApiClient 的 stageFile / revertFile / stageHunk / revertHunk 调用正确的 changes.* RPC。
// 下半：ChangesTab 在零 DOM 桩里真跑一遍「点 hunk/stage → 调 RPC → 刷新清单 → 提示」闭环，
// 坐实「hunk / 文件级接受（stage）与拒绝（revert）联动真实写入」在 UI 这一侧也成立。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const { ApiClient } = await import('../dist/core/ApiClient.js');

// ChangesTab 走 useApp()（React.createContext）与 deps.js，先种运行时桩再动态加载组件。
const runtime = createRuntime();
runtime.install();
const { ChangesTab } = await import('../dist/ui/components/tabs/ChangesTab.js');

/** 捕获一次 RPC 调用（method + params）。 */
async function captureRpc(fn) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  };
  const api = new ApiClient();
  const res = await fn(api);
  const body = JSON.parse(calls[0].init.body);
  return { calls, body, res };
}

test('stageFile 调用 changes.stageFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.stageFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.stageFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('revertFile 调用 changes.revertFile RPC', async () => {
  const { body, res } = await captureRpc((api) => api.revertFile('src/app.ts'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.revertFile');
  assert.deepEqual(body.params, { path: 'src/app.ts' });
});

test('stageHunk 调用 changes.stageHunk RPC（含 hunk 与 isNew）', async () => {
  const { body, res } = await captureRpc((api) => api.stageHunk('src/app.ts', '@@ -1,3 +1,3 @@', true));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.stageHunk');
  assert.deepEqual(body.params, { path: 'src/app.ts', hunk: '@@ -1,3 +1,3 @@', isNew: true });
});

test('revertHunk 调用 changes.revertHunk RPC（含 hunk）', async () => {
  const { body, res } = await captureRpc((api) => api.revertHunk('src/app.ts', '@@ -1,3 +1,3 @@'));
  assert.deepEqual(res, { ok: true });
  assert.equal(body.method, 'changes.revertHunk');
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

/**
 * 安装 API / 对话框 / toast 桩并渲染一次已展开文件的 ChangesTab。
 * @param isGit 是否 git 工作区
 * @returns 渲染产物与调用记录
 */
function renderChangesTab(isGit = true) {
  const calls = { listChanges: 0, stageHunk: [], stageFile: [], revertHunk: [], revertFile: [], comments: 0, confirms: 0 };
  const toasts = [];
  runtime.appContext.api = {
    async listChanges(path) {
      calls.listChanges += 1;
      return path === undefined
        ? { source: isGit ? 'git' : 'session', branch: isGit ? 'main' : undefined, files: FILES }
        : { source: isGit ? 'git' : 'session', patch: PATCH };
    },
    async stageHunk(path, hunk, isNew) {
      calls.stageHunk.push({ path, hunk, isNew });
      return { ok: true };
    },
    async stageFile(path) {
      calls.stageFile.push(path);
      return { ok: true };
    },
    async revertHunk(path, hunk) {
      calls.revertHunk.push({ path, hunk });
      return { ok: true };
    },
    async revertFile(path) {
      calls.revertFile.push(path);
      return { ok: true };
    },
    async listDiffComments() {
      calls.comments += 1;
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
  return { vnode, calls, toasts };
}

/** 取指定 title 片段的按钮。 */
function buttonByTitle(vnode, titlePart) {
  const btn = collect(
    vnode,
    (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('hunk-btn') && String(n.props.title ?? '').includes(titlePart),
  )[0];
  return btn ?? null;
}

test('ChangesTab：hunk「stage」调 changes.stageHunk（含真实 hunk 文本）并刷新清单 + 成功提示', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const stageBtn = buttonByTitle(vnode, 'stage 该改动块');
  assert.ok(stageBtn, 'git 工作区必须渲染 hunk stage 按钮');

  calls.listChanges = 0;
  stageBtn.props.onClick();
  await flush();

  assert.equal(calls.stageHunk.length, 1, '必须且只调一次 changes.stageHunk');
  assert.equal(calls.stageHunk[0].path, 'src/app.ts');
  assert.match(calls.stageHunk[0].hunk, /^@@ -1,3 \+1,3 @@/, '送给服务端的必须是完整 hunk（含 @@ 头）');
  assert.match(calls.stageHunk[0].hunk, /\+const b = 3;/);
  assert.equal(calls.stageHunk[0].isNew, false, '已有 @@ 的文件不是新文件');
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已 stage 该块', k: 'ok' });
});

test('ChangesTab：hunk「丢弃」先确认再调 changes.revertHunk 并刷新 + 提示', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const revertBtn = buttonByTitle(vnode, '丢弃该改动块');
  assert.ok(revertBtn, 'git 工作区必须渲染 hunk 丢弃按钮');

  calls.listChanges = 0;
  revertBtn.props.onClick();
  await flush();

  assert.equal(calls.confirms, 1, '破坏性操作必须先经 DialogService 确认');
  assert.equal(calls.revertHunk.length, 1);
  assert.equal(calls.revertHunk[0].path, 'src/app.ts');
  assert.match(calls.revertHunk[0].hunk, /^@@ -1,3 \+1,3 @@/);
  assert.ok(calls.listChanges >= 1, '成功后必须重新拉取变更清单');
  assert.deepEqual(toasts[0], { m: '已还原该块', k: 'ok' });
});

test('ChangesTab：文件级「stage 文件」调 changes.stageFile 并刷新', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  const fileBtn = buttonByTitle(vnode, 'stage 整个文件');
  assert.ok(fileBtn, 'git 工作区必须渲染文件级 stage 按钮');

  calls.listChanges = 0;
  fileBtn.props.onClick();
  await flush();

  assert.deepEqual(calls.stageFile, ['src/app.ts']);
  assert.ok(calls.listChanges >= 1);
  assert.deepEqual(toasts[0], { m: '已 stage：src/app.ts', k: 'ok' });
});

test('ChangesTab：非 git 工作区不提供 stage / 丢弃（无真实写入可联动）', () => {
  const { vnode } = renderChangesTab(false);
  assert.equal(buttonByTitle(vnode, 'stage'), null);
  assert.equal(buttonByTitle(vnode, '丢弃'), null);
});

test('ChangesTab：操作失败只提示错误、不刷新清单（fail-closed）', async () => {
  const { vnode, calls, toasts } = renderChangesTab(true);
  runtime.appContext.api.stageHunk = async () => {
    throw new Error('hunk 不适用');
  };
  const stageBtn = buttonByTitle(vnode, 'stage 该改动块');
  calls.listChanges = 0;
  stageBtn.props.onClick();
  await flush();
  assert.deepEqual(toasts[0], { m: 'hunk 不适用', k: 'err' });
  assert.equal(calls.listChanges, 0, '失败不得假刷新');
});
