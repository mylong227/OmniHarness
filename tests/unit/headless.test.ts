import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** CLI 入口路径。 */
const cliPath = resolve(process.cwd(), 'dist/src/cli/exec.js');

/**
 * headless 模式（--print / -p）冒烟测试。
 * 对齐 `claude -p` / `codex exec`：单次非交互执行、结果落 stdout、非零退出码。
 */

test('headless：-p 单次非交互执行，结果输出到 stdout，退出码 0', () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, '--prompt', '用一句话介绍自己', '--model-adapter', 'mock', '-p'],
    { encoding: 'utf8', timeout: 120000 },
  );
  // 不应出现任何过程事件噪声（TUI/进度）；应有最终文本。
  assert.ok(output.trim().length > 0, 'headless 必须有最终文本输出');
  assert.doesNotMatch(output, /tool_call|step \d|思考中|thinking/i);
});

test('headless：-p 支持 --output-format json 机器可读输出', () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, '--prompt', 'hi', '--model-adapter', 'mock', '-p', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 120000 },
  );
  const parsed = JSON.parse(output.trim());
  assert.strictEqual(parsed.ok, true);
  assert.ok(typeof parsed.finalText === 'string');
});

test('headless 安全网：approval=ask 在无 stdin 环境会永久挂起，必须显式失败（非零退出）', () => {
  let failed = false;
  let stderr = '';
  try {
    execFileSync(
      process.execPath,
      [cliPath, '--prompt', 'hi', '--model-adapter', 'mock', '-p', '--approval', 'ask'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    failed = true;
    stderr = (error as { stderr?: string })?.stderr ?? '';
  }
  assert.strictEqual(failed, true, 'approval=ask 的 headless 必须显式报错而非挂起');
  assert.match(stderr, /headless|挂起|stdin/i, '错误信息应点明交互审批会挂起');
});
