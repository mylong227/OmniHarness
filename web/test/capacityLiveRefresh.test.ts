// 容量小图表（左栏 `CapacityDock`）的取数判据。
//
// 2026-10-09 用户报「容量上下文不能实时同步数据」；2026-10-28 容量入口最终收口到左栏底部的小图表
// （控制台详情页已撤）。取数时机拆成两层：
//   · 常驻收起态：挂载 + `sessionTick` 变化（会话事件去抖后 +1）时取数；
//   · 浮层展开：额外开 5s 兜底轮询（配额重置/时间敏感字段），收起即停——
//     左栏常驻小图表不能每 5s 回放一次事件日志。
//
// ## 判据
//
// | # | 判据 | 反例形态 |
// |---|------|----------|
// | ① | 取数 effect 依赖含 `sessionTick`，且不含回调 | 塞进内联回调 ⇒ 2026-10-06"6 秒 23 次 /rpc"复发 |
// | ② | 5s 轮询只在 `active` 为真时建立，收起即清理 | 常驻每 5s 打一次 `context.usage`（大会话回放日志） |
// | ③ | 链路：`CapacityDock` → hook；输入区/控制台/路由不再有第二入口 | 多一个入口 ⇒ "容量面板到底在哪"再次分裂 |

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');

/**
 * 读一份前端源码。
 * @param rel 相对 `web/src` 的路径
 * @returns 源码
 */
function srcOf(rel: string): string {
  return readFileSync(join(WEB_ROOT, 'src', rel), 'utf8');
}

test('① 取数依赖只放语义量（sessionTick 等），不放回调', () => {
  const hook = srcOf('ui/components/useCapacityReport.ts');
  assert.match(hook, /export function useCapacityReport\(active: boolean = true\)/, 'hook 只接 active');
  const deps = [...hook.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  const fetchDeps = deps.find((d) => d.includes('sessionTick'));
  assert.ok(fetchDeps !== undefined, '未找到取数 effect 的依赖数组（解析口径可能过期）');
  for (const banned of ['onToast', 'reload', 'props']) {
    assert.ok(
      !new RegExp(`(^|[,\\s])${banned}([,\\s]|$)`).test(fetchDeps),
      `依赖数组不得含 ${banned}（回调身份每渲染都变 ⇒ 取数 effect 会自己转起来）`,
    );
  }
  assert.match(hook, /const \{ api, sessionId, sessionTick \} = useApp\(\);/, 'api 必须取自 AppContext');
});

test('② 5s 兜底只在展开态建立，收起即清理（常驻不轮询）', () => {
  const hook = srcOf('ui/components/useCapacityReport.ts');
  assert.match(hook, /if \(!active\) return undefined;/, 'active 为 false 时必须早退');
  assert.match(hook, /\}, \[active\]\);/, '轮询 effect 的依赖必须含 active');
  const dock = srcOf('ui/components/CapacityDock.tsx');
  assert.match(dock, /useCapacityReport\(open\)/, '小图表必须把展开态作为 active 传入');
});

test('③ 链路：小图表 → hook；输入区 / 控制台 / 路由不再有第二入口', () => {
  const dock = srcOf('ui/components/CapacityDock.tsx');
  assert.match(dock, /usePopoverEffect\(open/, '展开态必须接入互斥与外部点击关闭');
  const composer = srcOf('ui/components/Composer.tsx');
  assert.doesNotMatch(composer, /ContextCapacityPanel|contextRevision|cap-/, '输入区不得再出现容量入口');
  // 控制台详情页已撤（2026-10-28 用户：「重复，保留左侧栏即可」）。
  const panels = srcOf('ui/models/PanelRegistry.ts');
  assert.doesNotMatch(panels, /key: 'capacity'/, 'PanelRegistry 不得再登记容量面板');
  const consoleReg = srcOf('ui/models/ConsoleRegistry.ts');
  assert.doesNotMatch(consoleReg, /'capacity'/, '控制台导航不得再出现容量页');
  const router = srcOf('core/Router.ts');
  assert.doesNotMatch(router, /'capacity'/, 'Router 不得再把 capacity 当合法 pane');
});
