/**
 * 容量面板「实时刷新 + 空 threadId 回落」判据（2026-10-07 用户两次实测）。
 *
 * ## 缺陷形态（用户原话）
 *
 * ① 「不会实时计算显示刷新容量面板上的数据」——面板原先只在「展开 / 换会话 / 忙闲翻转」三个时刻
 *    各取一次数，而容量快照是**回合推进中逐步产生**的 ⇒ 长回合里数字冻住（真机：回合进行中一直
 *    显示 `0/12.8万` 全零）。
 * ② 新会话的 `threadId` 要等 `turns.run` 返回后客户端才知道，而面板在第一回合进行中就已经打开
 *    ⇒ 客户端只能传空串 ⇒ 服务端原样返回全零报告（`source: 'empty'`）。
 *
 * ## 判据（源码级接线守卫 + 服务端回落语义）
 *
 * - 面板：打开且忙时必须注册**固定间隔**的实时轮询，且取数 effect 依赖刷新计数 tick；
 * - 服务端：`context.usage` 的 threadId 必须经 `usageThreadId` 解析，空串时回落到**正在跑的会话**
 *   （`Agent.runningSessionIds()` 末条）。
 *
 * 为什么用源码级判据：① 面板的轮询要靠真实定时器推进，而测试桩的 `setInterval` 恒返回 0
 * （不推进）；② `usageThreadId` 是服务端类的 protected 逻辑，实例化整台 AppServer 代价过大。
 * 本仓同类接线守卫先例：`web/test/streamWindowAnchor.test.mjs`、`tests/unit/knownFlags.test.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（`dist/tests/unit` → 上溯三级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PANEL = join(REPO_ROOT, 'web', 'src', 'ui', 'components', 'ContextCapacityPanel.tsx');
const HANDLERS = join(REPO_ROOT, 'src', 'server', 'core', 'appServerSurfaceHandlers.ts');

describe('容量面板：回合进行中必须实时刷新（用户报「不会实时计算显示刷新」）', () => {
  const src = readFileSync(PANEL, 'utf8');

  it('打开且忙时注册固定间隔轮询（间隔是显式常量，不写魔法数）', () => {
    assert.match(src, /const LIVE_REFRESH_MS = \d+;/, '刷新间隔必须是显式常量');
    assert.match(
      src,
      /if \(!open \|\| busy !== true\) return undefined;[\s\S]{0,200}setInterval\(\(\) => setTick\(\(t\) => t \+ 1\), LIVE_REFRESH_MS\)/,
      '轮询必须在「展开且回合进行中」时注册，且间隔取 LIVE_REFRESH_MS',
    );
    assert.match(src, /clearInterval\(timer\)/, '收起 / 卸载必须摘掉定时器（否则留下后台心跳）');
  });

  it('取数 effect 依赖刷新计数 tick（轮询才能真的把数字刷上去）', () => {
    assert.match(
      src,
      /\}, \[open, threadId, busy, tick\]\);/,
      '取数必须依赖 tick；只依赖 open/threadId/busy 时轮询形同虚设（这正是用户报的"不刷新"）',
    );
  });

  it('闲时不轮询（`context.usage` 要回放事件日志，闲着轮询是白烧 IO）', () => {
    assert.match(src, /busy !== true\) return undefined;/, '忙闲判据必须写在轮询 effect 的入口');
  });
});

describe('容量面板：空 threadId 回落到正在跑的会话（新会话第一回合也能看到真实数字）', () => {
  const src = readFileSync(HANDLERS, 'utf8');

  it('context.usage 的 threadId 必须经 usageThreadId 解析', () => {
    assert.match(
      src,
      /contextUsage\.usage\(this\.usageThreadId\(this\.stringParam\(params, 'threadId'\)\)\)/,
      '直接透传空串会让面板在第一回合显示全零（用户实测的 `0/12.8万`）',
    );
  });

  it('回落取「正在跑的会话」末条（插入序 ⇒ 最新那个）', () => {
    assert.match(src, /runningSessionIds\(\)/, '回落必须问 Agent 的在跑会话，而不是猜');
    assert.match(
      src,
      /running\[running\.length - 1\]/,
      '并发回合时取最新登记的那个（插入序末条），避免把面板钉在旧会话上',
    );
  });
});
