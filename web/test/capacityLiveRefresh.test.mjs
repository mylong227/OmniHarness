// 容量面板「实时刷新」的判据（2026-10-09 用户报「容量上下文不能实时同步数据」）。
//
// ## 缺陷分两半，这一半在前端
//
// 后端那半（读的是落盘快照 ⇒ 回合头一两秒根本没有数据）修在 `Agent.eventsOf`，判据见
// `tests/unit/liveEventRead.test.ts`。前端这半是**取数时机晚于数据产生**：面板只在
// 「打开 / 换会话 / 忙闲翻转」+ 忙时 2s 定时器取数 ⇒ 新快照已经在了，界面却还在等定时器。
//
// 修法：把「容量数据代数」（`model` 事件条数）从事件流算出来，透传给面板作为**取数依赖**，
// 新快照一到就取；定时器退化为兜底。
//
// ## 判据
//
// | # | 判据 | 反例形态 |
// |---|------|----------|
// | ① | 代数只数 `model` 事件，且对无关事件不敏感 | 数成"所有事件" ⇒ 每个 token 增量都触发一次取数 |
// | ② | 面板把代数写进取数 effect 的**依赖数组** | 只接 prop 不用 ⇒ 完全没效果（"声明未接线"） |
// | ③ | 依赖数组里只允许语义量（数字/布尔），不得出现对象或回调 | 塞进 `api`/`onToast` ⇒ 2026-10-06 那场"打开 6 秒 23 次 /rpc"复发 |
// | ④ | StreamView 真的把代数算出来并传下去（经 Composer 透传） | 链路断在任一层 ⇒ 判据②绿但线上无效果 |

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './hooksStub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');

// deps.js 在模块顶层读 window，须先种零 DOM 桩。
createRuntime().install();
const { ContextUsageView } = await import('../dist/ui/models/ContextUsageView.js');

test('① 代数只数 model 事件：增量与存储形态的事件都不算数', () => {
  assert.equal(ContextUsageView.revisionOf([]), 0);
  assert.equal(ContextUsageView.revisionOf([{ type: 'user' }]), 0);
  assert.equal(ContextUsageView.revisionOf([{ type: 'user' }, { type: 'model' }]), 1);
  assert.equal(
    ContextUsageView.revisionOf([{ type: 'model' }, { type: 'tool_call' }, { type: 'model' }, { type: 'assistant' }]),
    2,
  );
  // 无 type 字段 / 非事件对象不得抛错（事件流可能有历史脏条目）
  assert.equal(ContextUsageView.revisionOf([{}, { type: undefined }]), 0);
  // 单调不减：新事件追加后代数只增（面板依赖"变化即取数"，回退会导致漏刷）
  const a = [{ type: 'model' }, { type: 'user' }];
  const b = [...a, { type: 'model' }];
  assert.ok(ContextUsageView.revisionOf(b) > ContextUsageView.revisionOf(a), '追加 model 事件后代数必须变大');
});

test('② 面板把代数写进取数 effect 的依赖数组（否则等于没接）', () => {
  const src = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'ContextCapacityPanel.tsx'), 'utf8');
  assert.match(src, /revision\?: number;/, 'props 必须声明 revision');
  // 取数 effect 的依赖数组是**唯一含 threadId 的那个**（[open, busy] 是定时器那个，别选错）
  const deps = [...src.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  const fetchDeps = deps.find((d) => d.includes('threadId'));
  assert.ok(fetchDeps !== undefined, '未找到取数 effect 的依赖数组（解析口径可能过期）');
  assert.ok(fetchDeps.includes('revision'), `取数依赖必须含 revision，实际：[${fetchDeps}]`);
});

test('③ 依赖数组里只允许语义量：不得出现对象/回调（防"每渲染重拉"复发）', () => {
  const src = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'ContextCapacityPanel.tsx'), 'utf8');
  const deps = [...src.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  const fetchDeps = deps.find((d) => d.includes('threadId'));
  assert.ok(fetchDeps !== undefined);
  for (const banned of ['api', 'onToast', 'props']) {
    assert.ok(
      !new RegExp(`(^|[,\\s])${banned}([,\\s]|$)`).test(fetchDeps),
      `依赖数组不得含 ${banned}（对象/回调身份每渲染都变 ⇒ 取数 effect 会自己转起来）`,
    );
  }
  // 反向接线：回调与 api 必须经 ref 使用（这正是"从依赖里拿掉它们"的前提）
  assert.match(src, /const apiRef = React\.useRef\(api\);/, 'api 必须放进 ref');
  assert.match(src, /const toastRef = React\.useRef\(onToast\);/, 'onToast 必须放进 ref');
});

test('④ 链路完整：StreamView 算代数 → Composer 透传 → 面板消费', () => {
  const view = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.match(
    view,
    /contextRevision=\{ContextUsageView\.revisionOf\(events\)\}/,
    'StreamView 必须由事件流算出代数并传给 Composer',
  );
  const composer = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'Composer.tsx'), 'utf8');
  assert.match(composer, /contextRevision\?: number;/, 'Composer 必须声明该 prop');
  assert.match(composer, /revision: contextRevision/, 'Composer 必须把它透传给容量面板');
  // 面板的 props 里确实读了这个字段（不是只声明）
  const panel = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'ContextCapacityPanel.tsx'), 'utf8');
  assert.match(panel, /busy, revision \} = props;/, '面板必须从 props 取出 revision');
});
