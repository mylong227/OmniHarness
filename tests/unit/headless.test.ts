import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileAsync } from '../helpers/childProcess.ts';
import { resolve } from 'node:path';

/** CLI 入口路径。 */
const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

/**
 * 子进程环境：**显式关掉** CLI 的语义检索默认档（\`OMNI_SEMANTIC_RECALL=0\`）。
 *
 * 为什么必须显式关：这些用例跑的是**真 agent 回合**（\`--model-adapter mock\`），而 CLI 的 agent
 * 路径默认把检索档打开 ⇒ 每次 spawn 都要加载嵌入模型与语义索引。实测本文件
 * **67.7s → 23.4s**；正因这笔开销，它在覆盖率插桩 + 全量并发下撞过 120s 文件预算。
 * 本文件不测检索 ⇒ 关掉既是**成本**也是**确定性**（不再依赖本机模型缓存/索引状态）。
 */
const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env, OMNI_SEMANTIC_RECALL: '0' };

/**
 * headless 模式（--print / -p）冒烟测试。
 * 对齐 `claude -p` / `codex exec`：单次非交互执行、结果落 stdout、非零退出码。
 */

test('headless：-p 单次非交互执行，结果输出到 stdout，退出码 0', async () => {
  const output = (
    await execFileAsync(
      process.execPath,
      [cliPath, '--prompt', '用一句话介绍自己', '--model-adapter', 'mock', '-p'],
      { encoding: 'utf8', timeout: 120000, env: CHILD_ENV },
    )
  ).toString();
  // 不应出现任何过程事件噪声（TUI/进度）；应有最终文本。
  assert.ok(output.trim().length > 0, 'headless 必须有最终文本输出');
  assert.doesNotMatch(output, /tool_call|step \d|思考中|thinking/i);
});

test('headless：-p 支持 --output-format json 机器可读输出', async () => {
  const output = (
    await execFileAsync(
      process.execPath,
      [cliPath, '--prompt', 'hi', '--model-adapter', 'mock', '-p', '--output-format', 'json'],
      { encoding: 'utf8', timeout: 120000, env: CHILD_ENV },
    )
  ).toString();
  const parsed = JSON.parse(output.trim());
  assert.strictEqual(parsed.ok, true);
  assert.ok(typeof parsed.finalText === 'string');
});

test('headless 安全网：approval=ask 在无 stdin 环境会永久挂起，必须显式失败（非零退出）', async () => {
  let failed = false;
  let stderr = '';
  try {
    await execFileAsync(
      process.execPath,
      [cliPath, '--prompt', 'hi', '--model-adapter', 'mock', '-p', '--approval', 'ask'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV },
    );
  } catch (error) {
    failed = true;
    stderr = (error as { stderr?: string })?.stderr ?? '';
  }
  assert.strictEqual(failed, true, 'approval=ask 的 headless 必须显式报错而非挂起');
  assert.match(stderr, /headless|挂起|stdin/i, '错误信息应点明交互审批会挂起');
});

test('单跑路径的 --approval ask 必须 fail-closed（此前会静默降级为全放行）', async () => {
  // 2026-10-06 排查发现：仓内**没有** AskApproval 适配器，`buildApproval` 的缺省分支是
  // `AutoApproval`（全放行）⇒ 非 headless 的 `--approval ask` 会"一次都不问"（fail-open 且无提示）。
  // 现在单跑入口直接拒绝；`ask` 仅在 `serve`（Web UI 提供审批上行）有意义。
  let failed = false;
  let stderr = '';
  try {
    await execFileAsync(
      process.execPath,
      [cliPath, '--prompt', 'hi', '--model-adapter', 'mock', '--approval', 'ask'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV },
    );
  } catch (error) {
    failed = true;
    stderr = (error as { stderr?: string })?.stderr ?? '';
  }
  assert.strictEqual(failed, true, '单跑路径的 approval=ask 必须非零退出');
  assert.match(stderr, /单跑|交互审批通道/, '错误信息应点明"本路径没有交互审批通道"');
});
