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
const APP_SERVER = join(REPO_ROOT, 'src', 'server', 'core', 'appServer.ts');
const APP_SERVER_BASE = join(REPO_ROOT, 'src', 'server', 'core', 'appServerBase.ts');

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

  it('取数 effect 依赖刷新计数 tick 与容量数据代数 revision（两者都必须真的刷上去）', () => {
    // 2026-10-09 追加 `revision`（`model` 事件条数，见 ContextUsageView.revisionOf）：
    // 容量快照每次模型调用产生一次 ⇒ 代数一到就取数，定时器 `tick` 退化为兜底。
    // 这两条合起来才拦得住用户报的两种「数字冻住」：定时器漏了 ⇒ 长回合中途不刷；
    // 代数漏了 ⇒ 新快照已产生却要干等一个定时器周期（实测差 1.4s vs 3.0s）。
    assert.match(
      src,
      /\}, \[open, threadId, busy, tick, revision\]\);/,
      '取数必须依赖 tick 与 revision；只依赖 open/threadId/busy 时轮询与事件驱动都形同虚设',
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

describe('不串项目：回合开始前运行时根必须对齐当前项目（用户：「应该各自分离不要出现串项目」）', () => {
  const entry = readFileSync(APP_SERVER, 'utf8');
  const base = readFileSync(APP_SERVER_BASE, 'utf8');

  it('回合入口必须调对齐（否则工具会去读另一个项目的树）', () => {
    assert.match(
      entry,
      /this\.alignRuntimeWorkspace\(threadId\);/,
      'runTurn 必须调用对齐：真机症状 = agent 读 A 项目、UI 打开 B 项目 ⇒ ENOENT',
    );
  });

  it('每回合如实记录两份根（runtimeRoot / displayRoot），分叉可见', () => {
    assert.match(
      base,
      /log\.info\('turn\.workspaceRoot', \{/,
      '两份根必须逐回合留痕，否则只能靠猜',
    );
    assert.match(base, /runtimeRoot,/, '必须记录运行时根');
    assert.match(base, /displayRoot,/, '必须记录显示根');
  });

  it('分叉时**重基**到当前项目，而不是带着分叉继续跑', () => {
    assert.match(
      base,
      /log\.warn\('turn\.workspaceRootDrift', \{ threadId, runtimeRoot, displayRoot \}\);[\s\S]{0,120}this\.switchWorkspace\(displayRoot\);/,
      '分叉必须回合前重基（走 switchWorkspace：按新根重造 tools/spill/longTermMemory）',
    );
  });

  it('触发条件必须收窄到「显示层**显式**给了工作区」（否则会把运行时推去启动目录）', () => {
    assert.match(
      base,
      /\(this\.displayConfig\['workspace'\] \?\? ''\) === '' \|\| runtimeRoot === displayRoot/,
      '没有 displayConfig.workspace 时 configStore.workspace() 会回落到 process.cwd()（启动目录）——' +
        '把它当权威正是「串项目」的成因；过宽的初版当场被 appServer.test.js 抓红',
    );
  });
});
