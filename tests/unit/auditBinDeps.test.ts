/**
 * audit 瘦入口（auditBin）的**依赖面判据**（2026-11-03 P1 T1.1/T1.3）。
 *
 * 瘦入口的全部价值在于"bundle 里只有 audit 世界"（零运行时依赖的 audit 应用 + 一个
 * AuditCommand）。这类约束靠自觉守不住——加一个 import 就悄悄把整个 CLI 世界拖进来，
 * npx 从"一条命令"退化回"全量安装"。故双保险：
 *
 * ① **结构判据**（本文件）：auditBin.ts 的静态 import 面必须封闭（禁止装配层模块），
 *    且 `AUDIT_NODE_REQUIRE` 与 package.json 的 engines.node 逐字一致（防两处漂移）；
 * ② **体积判据**（scripts/buildAuditBin.mjs 内置，≤ 300 KB）：结构判据漏掉的间接拖入
 *    （比如引了一个"看起来无害"的模块、而它自己又依赖装配层）由产物体积兜底。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// 真 import（不是读文本）：让 auditBin.ts 进入覆盖率报告（coverageInventory 判据要求
// 新源文件出现在报告里），同时 ② 对账的就是**真实常量**而不是正则抽出来的字符串。
import { AUDIT_NODE_REQUIRE, AuditBin } from '../../src/apps/cli/auditBin.ts';

const ROOT = process.cwd();
const SOURCE = readFileSync(join(ROOT, 'src', 'apps', 'cli', 'auditBin.ts'), 'utf8');

test('① auditBin 静态 import 面封闭：不得引入装配层 / 重模块（bundle 会被拖成 MB 级）', () => {
  // 相对导入 + node 内建模块都放行（audit 应用本身零运行时依赖）；
  // 装配层与 CLI 继承链一律拒绝——它们是"整个 CLI 世界"的入口。
  const forbidden = [
    'execCli',
    'execLocal',
    'cliDataCmds',
    'cliAgentCmds',
    'cliBuildConfig',
    'cliServerCmds',
    'argParser',
    'cliFlagTable',
    'crashGuard',
  ];
  const importTargets = [...SOURCE.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
  const offenders = importTargets.filter((target) =>
    forbidden.some((name) => target.includes(`/${name}`) || target === `./${name}`),
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `auditBin.ts 引入了装配层模块：${offenders.join(', ')}——bundle 会被整个 CLI 世界拖大`,
  );
});

test('② AUDIT_NODE_REQUIRE 与 package.json engines.node 逐字一致（--help 头部的版本门槛不漂移）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    engines: { node: string };
  };
  // auditBin 的常量是内联进单文件 bundle 的，必须与包声明同源（判据对账，不靠自觉）。
  assert.strictEqual(AUDIT_NODE_REQUIRE, pkg.engines.node);
});

test('③ main()：--version 快速路径 / --help 头部带 Node 门槛 / 正常分派退出码同主 CLI 契约', async () => {
  const argvBackup = process.argv;
  const exitBackup = process.exitCode;
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    // --version：零重模块路径，exit 0。
    process.argv = ['node', 'audit.mjs', '--version'];
    await AuditBin.main();
    assert.strictEqual(process.exitCode, 0);
    assert.match(writes.join(''), /omniharness audit \d+\.\d+\.\d+/);
    writes.length = 0;

    // --help：头部先打 Node 门槛行，随后 AuditCommand 的 USAGE（exit 2）。
    process.argv = ['node', 'audit.mjs', '--help'];
    await AuditBin.main();
    assert.strictEqual(process.exitCode, 2);
    assert.match(writes.join(''), /需要 Node >=22\.14\.0/);
    assert.match(writes.join(''), /用法:/);
    writes.length = 0;

    // 正常分派：干净夹具 ⇒ 0；漂移夹具 --strict ⇒ 1（与主 CLI 同一退出码契约）。
    process.argv = [
      'node',
      'audit.mjs',
      join(process.cwd(), 'tests', 'fixtures', 'audit', 'omni.jsonl'),
      '--format',
      'json',
      '--out',
      join(tmpdir(), `omni-auditbin-${String(Date.now())}.json`),
    ];
    await AuditBin.main();
    assert.strictEqual(process.exitCode, 0);
    process.argv = [
      'node',
      'audit.mjs',
      join(process.cwd(), 'tests', 'fixtures', 'audit', 'drift-mixed.jsonl'),
      '--strict',
      '--out',
      tmpdir(),
    ];
    await AuditBin.main();
    assert.strictEqual(process.exitCode, 1);
  } finally {
    process.argv = argvBackup;
    process.exitCode = exitBackup;
    process.stdout.write = originalWrite;
  }
});
