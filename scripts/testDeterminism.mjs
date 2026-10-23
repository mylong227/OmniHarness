#!/usr/bin/env node
/**
 * 测试确定性探针（`npm run test:determinism`）。
 *
 * 对一组**纯逻辑/无网络**判据跑 3 次，每次换 shuffle 种子；任一次失败即视为确定性回归。
 * 不比较输出文本（测试不该断言随机顺序），只验证「同输入多次运行都通过」。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FILES = [
  'tests/unit/router.test.ts',
  'tests/unit/mcpAuth.test.ts',
  'tests/unit/egressPolicy.test.ts',
  'tests/unit/tracePatchPlanner.test.ts',
  'tests/unit/longMemEval.test.ts',
  'tests/unit/skillManifestSigner.test.ts',
];

let failed = false;
for (let run = 1; run <= 3; run += 1) {
  process.stdout.write(`\n▶ determinism run ${String(run)}/3\n`);
  const result = spawnSync(
    process.execPath,
    [
      VITEST,
      'run',
      '--project',
      'node',
      ...FILES,
      '--sequence.shuffle',
      `--sequence.seed=${String(run)}`,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`✗ run ${String(run)} 失败（exit ${String(result.status)}）\n`);
  }
}
process.exit(failed ? 1 : 0);
