/**
 * F1 CLI 判据（`license` 子命令）：引擎必须被**真实路径**消费，且降级语义在出口也可读。
 *
 * ## 判据要钉死什么
 *
 * 1. **有效 license ⇒ 退出码 0** 且打印档位与该档可用功能；
 * 2. **过期 ⇒ 退出码 1**，但必须**明确写出"核心功能照常可用"**（沿 F1 判据②：降级不是停摆）
 *    并提示续期恢复；
 * 3. **文件读不到 / 无参数 ⇒ 如实区分**（路径问题 vs 用法问题，退出码 1 vs 2）；
 * 4. **不内置公钥**：不给 `--license-public-key` 即用法错误（退出码 2）——
 *    内置公钥等于把"谁能授权"写死在开源代码里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LicenseCommand } from '../../src/cli/licenseCommand.js';
import { LicenseEngine } from '../../src/license/licenseEngine.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import type { LicensePayload } from '../../src/license/licenseEngine.js';

/** 固定"当前时刻"。 */
const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * 采集 stdout/stderr 并跑命令（命令按 CLI 契约写这两条流）。
 * @param run 被测动作
 * @returns 两条流文本与退出码
 */
async function capture(run: () => Promise<number>): Promise<{
  readonly out: string;
  readonly err: string;
  readonly code: number;
}> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), code };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = originalOut;
    (process.stderr as unknown as { write: unknown }).write = originalErr;
  }
}

/**
 * 写一份 license 文件（真实签名）。
 * @param overrides 正文覆盖
 * @returns license 路径、公钥与正文
 */
function writeLicense(overrides: Partial<LicensePayload> = {}): {
  readonly path: string;
  readonly publicKeySsh: string;
} {
  const licensor = new Ed25519AgentIdentity({ agentRuntimeId: 'licensor' });
  const payload: LicensePayload = {
    licenseId: 'lic-cli',
    tier: 'pro',
    machineFingerprint: LicenseEngine.machineFingerprint(),
    issuedAtMs: NOW - 30 * DAY,
    expiresAtMs: NOW + 30 * DAY,
    ...overrides,
  };
  const text = LicenseEngine.compose(
    payload,
    licensor.sign(LicenseEngine.canonicalPayload(payload)),
  );
  const path = join(mkdtempSync(join(tmpdir(), 'omni-license-')), 'license.txt');
  writeFileSync(path, text, 'utf8');
  return { path, publicKeySsh: licensor.publicKeySsh() };
}

test('F1 CLI：有效 license ⇒ 退出码 0，打印档位与已启用功能', async () => {
  const { path, publicKeySsh } = writeLicense({ tier: 'team' });
  const { out, code } = await capture(() =>
    new LicenseCommand().run(['status', '--license', path, '--license-public-key', publicKeySsh]),
  );
  assert.strictEqual(code, 0);
  assert.match(out, /档位 team/);
  assert.match(out, /已启用功能：/);
  assert.match(out, /governance-console/, 'team 必须含 Pro 功能（档位是包含关系）');
});

test('F1 CLI 判据②：过期 ⇒ 退出码 1，但必须写明「核心功能照常可用」并提示续期', async () => {
  const { path, publicKeySsh } = writeLicense({
    tier: 'pro',
    issuedAtMs: NOW - 60 * DAY,
    expiresAtMs: NOW - DAY,
  });
  const { err, code } = await capture(() =>
    new LicenseCommand().run(['status', '--license', path, '--license-public-key', publicKeySsh]),
  );
  assert.strictEqual(code, 1, '过期必须非零退出（否则脚本无法察觉）');
  assert.match(err, /已过期/);
  assert.match(err, /核心功能照常可用/, '降级不是停摆：必须明确告知核心功能可用');
  assert.match(err, /续期后即可恢复/, '必须给出恢复路径（否则用户只知道"坏了"）');
});

test('F1 CLI：文件不存在 ⇒ 退出码 1 且说清是路径问题；缺参数 ⇒ 用法错误 2', async () => {
  const { publicKeySsh } = writeLicense();
  const missing = await capture(() =>
    new LicenseCommand().run([
      'status',
      '--license',
      join(tmpdir(), 'definitely-missing-license.txt'),
      '--license-public-key',
      publicKeySsh,
    ]),
  );
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /无法读取 license 文件/);
  assert.match(missing.err, /核心功能照常可用/);

  // 4. 不内置公钥：缺 --license-public-key ⇒ 用法错误。
  const noKey = await capture(() => new LicenseCommand().run(['status', '--license', 'x.txt']));
  assert.strictEqual(noKey.code, 2);
  assert.match(noKey.out, /用法:/);

  const badSub = await capture(() => new LicenseCommand().run(['bogus']));
  assert.strictEqual(badSub.code, 2);
  assert.match(badSub.out, /用法:/);
});
