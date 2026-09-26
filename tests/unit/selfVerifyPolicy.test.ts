/**
 * P3 自验证策略单测（零依赖；用 os.tmpdir 造临时仓库）。
 *
 * 覆盖：确定性触发器（仓库须有 `scripts.test` 才启用）、默认预算、覆盖项、
 * 可验证目标扩展名判定、异常路径 fail-closed。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';

/** 造一个临时仓库目录（含给定 package.json 内容；null 表示不写文件）。 */
const makeRepo = (pkg: string | null): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-selfverify-'));
  if (pkg !== null) {
    writeFileSync(join(dir, 'package.json'), pkg, 'utf8');
  }
  return dir;
};

test('forWorkspace：仓库含 scripts.test 才启用', () => {
  const dir = makeRepo(JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  try {
    const policy = SelfVerifyPolicy.forWorkspace(dir);
    assert.ok(policy !== undefined);
    assert.strictEqual(policy.command, SelfVerifyPolicy.DEFAULT_COMMAND);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forWorkspace：无 package.json → 不启用', () => {
  const dir = makeRepo(null);
  try {
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forWorkspace：package.json 无 scripts.test → 不启用', () => {
  const dir = makeRepo(JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
  try {
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forWorkspace：package.json 非法 JSON → 不启用（fail-closed，不抛错）', () => {
  const dir = makeRepo('{ not json');
  try {
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forWorkspace：空 workspaceRoot → 不启用', () => {
  assert.strictEqual(SelfVerifyPolicy.forWorkspace('   '), undefined);
});

test('默认预算保守（超时 / 冷却 / 次数 / 摘要行数）', () => {
  const p = SelfVerifyPolicy.from();
  // 300s（2026-09-26 审计 A3 上调，原 120s）：带构建步骤的测试命令（本仓 npm test = build + 单测）
  // 两分钟根本不够，实测「首次触发即超时、3 次预算被白烧」⇒ 功能形同不存在。
  assert.strictEqual(p.timeoutMs, 300_000);
  assert.strictEqual(p.cooldownMs, 60_000);
  assert.strictEqual(p.maxRunsPerSession, 3);
  assert.strictEqual(p.maxDigestLines, 15);
  assert.strictEqual(p.maxOutputBytes, 262_144);
});

test('超时可由环境变量覆盖，非法值回落默认（不静默变 NaN）', () => {
  const saved = process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY];
  try {
    process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY] = '45000';
    assert.strictEqual(SelfVerifyPolicy.from().timeoutMs, 45_000);
    for (const bad of ['abc', '-1', '0', 'NaN', 'Infinity', '   ']) {
      process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY] = bad;
      assert.strictEqual(
        SelfVerifyPolicy.from().timeoutMs,
        SelfVerifyPolicy.DEFAULT_TIMEOUT_MS,
        `非法值 ${JSON.stringify(bad)} 应回落默认`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY];
    else process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY] = saved;
  }
});

test('覆盖项生效（含 command）', () => {
  const p = SelfVerifyPolicy.from({ command: 'pnpm test', timeoutMs: 5, maxRunsPerSession: 1 });
  assert.strictEqual(p.command, 'pnpm test');
  assert.strictEqual(p.timeoutMs, 5);
  assert.strictEqual(p.maxRunsPerSession, 1);
  assert.strictEqual(p.cooldownMs, 60_000);
});

test('isVerifiableTarget：源码扩展名判定', () => {
  for (const p of ['a.ts', 'src/b.tsx', 'x/y.mjs', 'q.py', 'r.rs', 's.go']) {
    assert.strictEqual(SelfVerifyPolicy.isVerifiableTarget(p), true, p);
  }
  for (const p of ['README.md', 'data.json', 'noext', '.gitignore', 'a.txt']) {
    assert.strictEqual(SelfVerifyPolicy.isVerifiableTarget(p), false, p);
  }
});
