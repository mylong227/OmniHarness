/**
 * CLI 检索默认档的**作用面**判据（2026-10-11）。
 *
 * ## 两件事一起钉（它们互为前提）
 *
 * 1. **生产侧**：`ExecCli.run()` 里 `applyCliRetrievalDefaults()` 只许在 **agent 路径**上调用
 *    （此前它在方法开头无条件调用 ⇒ `kv` / `session` / 用法提示这类不碰检索的路径也会把
 *    `OMNI_SEMANTIC_RECALL` 这个进程级默认打开）。
 *    **诚实边界**：这一收窄**不会**让子命令变快（实测 `boost probe list` 1.67s → 1.72s，那 ~2s
 *    是整条命令继承链的加载与配置分层，已另立登记项）；它换来的是**影响面**。
 * 2. **测试侧**：真正省时间的是 spawn 时**显式关闭**——`headless.test.ts` 跑 4 条真 agent 回合，
 *    实测 **67.7s → 23.4s**（`OMNI_SEMANTIC_RECALL=0`），并因此在覆盖率插桩 + 全量并发下
 *    撞过 120s 文件预算。故该文件每处 spawn 都必须带 `env: CHILD_ENV`（内含 `=0`）。
 *
 * 两侧都用**源码级检查 + 合成坏输入正对照**：这类"作用面/接线"约束没有运行时观测口，
 * 但正对照能证明检查器不是恒真。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 仓库根（判据在 `dist/tests/unit/`，源码按 cwd 读）。 */
const REPO_ROOT = process.cwd();

/** 读源码。 */
function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/**
 * 检查器①：`run()` 里的检索默认档是否落在 agent 路径之后。
 *
 * @param source `execCli.ts` 源码。
 * @returns 违规说明；合规时为空数组。
 */
function retrievalScopingViolations(source: string): string[] {
  const callAt = source.indexOf('this.applyCliRetrievalDefaults();');
  if (callAt < 0) return ['找不到 applyCliRetrievalDefaults() 调用'];
  // agent 路径的标志：落到 `let restoreEgress` 那段（未匹配任何子命令时的兜底分支）。
  const agentAt = source.indexOf('let restoreEgress');
  if (agentAt < 0) return ['找不到 agent 兜底分支（let restoreEgress）'];
  if (callAt > agentAt) return [];
  // 调用点在兜底分支之前 ⇒ 说明它对所有子命令生效（旧行为）。
  const lastDispatch = source.lastIndexOf("if (argv[0] === '");
  return callAt > lastDispatch
    ? []
    : ['applyCliRetrievalDefaults() 在子命令分发之前被调用（对所有子命令生效）'];
}

/**
 * 检查器②：某测试文件的每处 spawn 是否都带了关检索的环境。
 *
 * @param source 测试源码。
 * @returns 违规说明；合规时为空数组。
 */
function spawnEnvViolations(source: string): string[] {
  if (!/OMNI_SEMANTIC_RECALL:\s*'0'/u.test(source)) {
    return ['没有把 OMNI_SEMANTIC_RECALL 显式设为 0'];
  }
  const spawns = [...source.matchAll(/execFileAsync\(/gu)].length;
  const withEnv = [...source.matchAll(/env:\s*CHILD_ENV/gu)].length;
  if (spawns === 0) return ['找不到 execFileAsync 调用（判据锚点失效）'];
  if (withEnv < spawns) return [`${String(spawns - withEnv)} 处 spawn 漏了 env: CHILD_ENV`];
  return [];
}

test('① 生产侧：检索默认档只作用于 agent 路径（附合成坏输入正对照）', () => {
  const source = read('src/cli/execCli.ts');
  assert.deepStrictEqual(retrievalScopingViolations(source), []);

  // **正对照**：把调用挪回方法开头（旧行为）必须被判违规。
  const legacy = source.replace(
    /  public async run\(argv: readonly string\[\]\): Promise<number> \{\n/,
    '  public async run(argv: readonly string[]): Promise<number> {\n    this.applyCliRetrievalDefaults();\n',
  );
  assert.notStrictEqual(legacy, source, '正对照变异未命中 ⇒ 判据锚点漂了');
  assert.ok(
    retrievalScopingViolations(legacy).length > 0,
    '把调用挪回开头却检不出来 ⇒ 判据①是恒真断言',
  );
});

test('② 测试侧：headless 每处 spawn 都必须显式关闭语义检索（附合成坏输入正对照）', () => {
  const source = read('tests/unit/headless.test.ts');
  assert.deepStrictEqual(spawnEnvViolations(source), []);

  // **正对照**：去掉一处 `env: CHILD_ENV` 必须被判违规。
  const broken = source.replace('env: CHILD_ENV', '');
  assert.notStrictEqual(broken, source, '正对照变异未命中 ⇒ 判据锚点漂了');
  assert.ok(spawnEnvViolations(broken).length > 0, '漏掉一处 env 却检不出来 ⇒ 判据②恒真');
});
