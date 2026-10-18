import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatchCandidatesTool } from '../../src/adapters/tool/fs/patchCandidatesTool.ts';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.ts';
import type {
  ShellRunOptions,
  ShellRunOutcome,
} from '../../src/adapters/tool/shell/shellProcessRunner.ts';
import type { DecisionEngine } from '../../src/ports/decision/decisionEngine.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';

/** 工具测试用固定策略（模型不能自带测试命令）。 */
const POLICY = SelfVerifyPolicy.from({ command: 'node test.mjs' });

/** 造一个最小工作区（源码 + 原文件）。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-candidates-'));
  writeFileSync(join(dir, 'sample.ts'), 'export const value = 1;\n', 'utf8');
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

/** 从 sample.ts 解析当前值。 */
function currentValue(dir: string): number {
  const text = readFileSync(join(dir, 'sample.ts'), 'utf8');
  const match = /value = (\d+)/u.exec(text);
  return Number(match?.[1] ?? NaN);
}

/** 造一次 shell 结果。 */
function outcome(exitCode: number | null, over: Partial<ShellRunOutcome> = {}): ShellRunOutcome {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode,
    signal: null,
    timedOut: false,
    overflowed: false,
    aborted: false,
    ...over,
  };
}

/** 构造工具调用。 */
function call(candidates: readonly string[], extra: Record<string, unknown> = {}): ToolCall {
  return {
    id: 'c1',
    name: 'patch_candidates',
    arguments: { candidates, ...extra },
  };
}

test('多候选：真实 ShellProcessRunner 端到端跑测试并只落胜者', async () => {
  const dir = workspace();
  try {
    writeFileSync(
      join(dir, 'test.mjs'),
      [
        "import { readFileSync } from 'node:fs';",
        "const text = readFileSync('sample.ts', 'utf8');",
        "process.exit(text.includes('value = 3') ? 0 : 1);",
      ].join('\n'),
      'utf8',
    );
    const tool = new PatchCandidatesTool(dir, { policy: POLICY });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.match(result.output ?? '', /已选候选 #1/u);
    assert.strictEqual(currentValue(dir), 3);
    assert.strictEqual(
      readFileSync(join(dir, 'sample.ts.bak'), 'utf8'),
      'export const value = 1;\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：测试自己改文件后仍恢复原状（不让测试副作用污染工作区）', async () => {
  const dir = workspace();
  try {
    writeFileSync(
      join(dir, 'test.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('sample.ts', 'export const value = 99;\\n', 'utf8');",
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );
    const tool = new PatchCandidatesTool(dir, { policy: POLICY });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(readFileSync(join(dir, 'sample.ts'), 'utf8'), 'export const value = 1;\n');
    assert.throws(() => readFileSync(join(dir, 'sample.ts.bak'), 'utf8'), /ENOENT/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：真实测试全部失败 ⇒ 恢复原文件且不留 .bak', async () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, 'test.mjs'), 'process.exit(1);\n', 'utf8');
    const tool = new PatchCandidatesTool(dir, { policy: POLICY });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(readFileSync(join(dir, 'sample.ts'), 'utf8'), 'export const value = 1;\n');
    assert.throws(() => readFileSync(join(dir, 'sample.ts.bak'), 'utf8'), /ENOENT/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：路径越界的候选在写盘前拒绝', async () => {
  const dir = workspace();
  try {
    const outside = [
      '--- a/../outside.txt',
      '+++ b/../outside.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const outside2 = outside.replaceAll('outside.txt', 'outside2.txt');
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: { run: async () => outcome(0) },
    });
    const result = await tool.handle(call([outside, outside2]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /路径越界/u);
    assert.strictEqual(currentValue(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：没有可用测试命令 ⇒ 写盘前失败', async () => {
  const dir = workspace();
  try {
    // 没有 package.json / 测试配置，也没有注入 policy。
    const tool = new PatchCandidatesTool(dir, { runner: { run: async () => outcome(0) } });
    const result = await tool.handle(
      { id: 'c1', name: 'patch_candidates', arguments: { candidates: [patch(2), patch(3)] } },
      { sessionId: 's1', workspaceRoot: dir } as ToolContext,
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /测试命令/u);
    assert.strictEqual(readFileSync(join(dir, 'sample.ts'), 'utf8'), 'export const value = 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：模型只能调小超时，不能突破 SelfVerifyPolicy 上限', async () => {
  const dir = workspace();
  try {
    const seen: number[] = [];
    const tool = new PatchCandidatesTool(dir, {
      policy: SelfVerifyPolicy.from({ command: 'node test.mjs', timeoutMs: 1000 }),
      runner: {
        run: async (_command: string, options: ShellRunOptions) => {
          seen.push(options.timeoutMs);
          return outcome(0);
        },
      },
    });
    const result = await tool.handle(call([patch(2), patch(3)], { timeout_ms: 999_999 }), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, true, result.error);
    assert.deepStrictEqual(seen, [1000, 1000]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：只有第二份通过 ⇒ 只写回第二份，并保留原始 .bak', async () => {
  const dir = workspace();
  try {
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: {
        run: async (_command: string, options: ShellRunOptions) => {
          const value = currentValue(options.cwd ?? dir);
          return outcome(value === 3 ? 0 : 1);
        },
      },
    });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, true, result.error);
    assert.match(result.output ?? '', /已选候选 #1/u);
    assert.strictEqual(currentValue(dir), 3);
    assert.strictEqual(
      readFileSync(join(dir, 'sample.ts.bak'), 'utf8'),
      'export const value = 1;\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：全部失败 ⇒ 逐字节恢复，不产生 .bak、不落任何候选', async () => {
  const dir = workspace();
  try {
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: { run: async () => outcome(1) },
    });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /工作区已恢复原状/u);
    assert.strictEqual(readFileSync(join(dir, 'sample.ts'), 'utf8'), 'export const value = 1;\n');
    assert.throws(() => readFileSync(join(dir, 'sample.ts.bak'), 'utf8'), /ENOENT/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：非法 diff 在写盘前淘汰，合法候选仍可胜出', async () => {
  const dir = workspace();
  try {
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: { run: async () => outcome(0) },
    });
    const invalid = 'this is not a unified diff';
    const result = await tool.handle(call([invalid, patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, true, result.error);
    assert.match(result.output ?? '', /写盘前淘汰/u);
    assert.strictEqual(currentValue(dir), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：显式 timeout_ms 透传到每候选测试，超时按失败处理', async () => {
  const dir = workspace();
  try {
    const seen: number[] = [];
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: {
        run: async (_command: string, options: ShellRunOptions) => {
          seen.push(options.timeoutMs);
          return outcome(null, { timedOut: true });
        },
      },
    });
    const result = await tool.handle(call([patch(2), patch(3)], { timeout_ms: 5000 }), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(seen, [5000, 5000]);
    assert.match(result.error ?? '', /超时/u);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：LaYa noul 只做同分 tie-breaker（不替代真实测试）', async () => {
  const dir = workspace();
  try {
    let calls = 0;
    const engine: DecisionEngine = {
      name: 'fake-laya',
      isAvailable: () => true,
      decide: async () => {
        calls += 1;
        return {
          available: true,
          answers: { passTest: { noul: calls === 1 ? 0.1 : 0.9 } },
        };
      },
    };
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: { run: async () => outcome(0) },
      decisionEngine: engine,
    });
    const result = await tool.handle(call([patch(2), patch(3)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, true, result.error);
    assert.match(result.output ?? '', /已选候选 #1/u, 'noul 更高的第二份应胜出');
    assert.strictEqual(currentValue(dir), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('多候选：候选数不在 2–3 ⇒ 写盘前拒绝', async () => {
  const dir = workspace();
  try {
    const tool = new PatchCandidatesTool(dir, {
      policy: POLICY,
      runner: { run: async () => outcome(0) },
    });
    const result = await tool.handle(call([patch(2)]), {
      sessionId: 's1',
      workspaceRoot: dir,
    } as ToolContext);
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /2–3/u);
    assert.strictEqual(readFileSync(join(dir, 'sample.ts'), 'utf8'), 'export const value = 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
