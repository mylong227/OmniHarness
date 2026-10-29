/**
 * 容量读数「空 threadId 回落 + 不串项目」判据（2026-10-07 用户两次实测）。
 *
 * ## 缺陷形态（用户原话）
 *
 * ① 新会话的 `threadId` 要等 `turns.run` 返回后客户端才知道，而容量读数在第一回合进行中就已经显示
 *    ⇒ 客户端只能传空串 ⇒ 服务端原样返回全零报告（`source: 'empty'`，真机 `0/12.8万`）。
 * ② 「应该各自分离不要出现串项目」——回合开始前运行时根未对齐当前项目，工具会去读别的项目的树。
 *
 * ## 判据（服务端接线守卫）
 *
 * - `context.usage` 的 threadId 必须经 `usageThreadId` 解析，空串时回落到**正在跑的会话**
 *   （`Agent.runningSessionIds()` 末条）；
 * - 回合入口必须把运行时根重基到当前项目，并逐回合留痕两份根。
 *
 * 2026-10-29：原先前 3 例断言 `ContextCapacityPanel.tsx` 的轮询源码——该组件已随容量迁到左栏
 * `CapacityDock` 而成为孤儿并删除，那 3 例一并裁掉（轮询行为现由 `web/test/capacityDock.test.ts`
 * 按新实现钉住）。
 *
 * 为什么用源码级判据：`usageThreadId` 是服务端类的 protected 逻辑，实例化整台 AppServer 代价过大。
 * 本仓同类接线守卫先例：`web/test/streamWindowAnchor.test.mjs`、`tests/unit/knownFlags.test.ts`。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（`dist/tests/unit` → 上溯三级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDLERS = join(REPO_ROOT, 'src', 'server', 'core', 'appServerSurfaceHandlers.ts');
const APP_SERVER = join(REPO_ROOT, 'src', 'server', 'core', 'appServer.ts');
const APP_SERVER_BASE = join(REPO_ROOT, 'src', 'server', 'core', 'appServerBase.ts');

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
