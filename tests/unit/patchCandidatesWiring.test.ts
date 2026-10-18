import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';

/** 造一个带测试脚本的最小工作区。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-patchers-wiring-'));
  writeFileSync(join(dir, 'sample.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(dir, 'test.mjs'), 'process.exit(0);\n', 'utf8');
  return dir;
}

/** 造一份把 value 改成 n 的单文件补丁。 */
function patch(value: number): string {
  return [
    '--- a/sample.ts',
    '+++ b/sample.ts',
    '@@ -1 +1 @@',
    '-export const value = 1;',
    `+export const value = ${String(value)};`,
  ].join('\n');
}

test('patch_candidates：selfVerify 开启时注册；关闭时不注册', () => {
  const dir = workspace();
  try {
    const base = {
      workspaceRoot: dir,
      maxSteps: 4,
      model: { generate: async () => ({ text: '' }) } as never,
      storage: new MemoryStorage(),
    };
    const enabled = ConfigFactory.build({
      ...base,
      selfVerify: { enabled: true, command: 'node test.mjs' },
    });
    const enabledNames = enabled.tools.list().map((definition) => definition.name);
    assert.ok(
      enabledNames.includes(TOOL_NAMES.patchCandidates),
      `自验证开启时应注册 ${TOOL_NAMES.patchCandidates}，实际：${enabledNames.join(',')}`,
    );
    assert.ok(
      enabledNames.includes(TOOL_NAMES.workflowMemory),
      `自验证开启时应注册 ${TOOL_NAMES.workflowMemory}，实际：${enabledNames.join(',')}`,
    );

    const disabled = ConfigFactory.build({ ...base });
    const disabledNames = disabled.tools.list().map((definition) => definition.name);
    assert.ok(
      !disabledNames.includes(TOOL_NAMES.patchCandidates),
      '未配置自验证时不应注册 patch_candidates（避免多一个只会失败的工具）',
    );
    assert.ok(
      !disabledNames.includes(TOOL_NAMES.workflowMemory),
      '未配置自验证时不应注册 workflow_memory',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('patch_candidates：经 ConfigFactory 装配后可执行，且使用配置层测试命令', async () => {
  const dir = workspace();
  try {
    const config = ConfigFactory.build({
      workspaceRoot: dir,
      maxSteps: 4,
      model: { generate: async () => ({ text: '' }) } as never,
      storage: new MemoryStorage(),
      selfVerify: { enabled: true, command: 'node test.mjs' },
    });
    const result = await config.tools.execute(
      {
        id: 'c1',
        name: TOOL_NAMES.patchCandidates,
        arguments: { candidates: [patch(2), patch(3)] },
      },
      { sessionId: 's1', workspaceRoot: dir },
    );
    assert.strictEqual(result.ok, true, result.error);
    assert.match(readFileSync(join(dir, 'sample.ts'), 'utf8'), /value = [23]/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
