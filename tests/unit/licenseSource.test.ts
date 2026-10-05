/**
 * F4 判据：**授权来源解析**（`LicenseSource`）——"这台机器现在是什么档"的取数面。
 *
 * ## 为什么这一层值得单独判
 *
 * 权益解析器（`FeatureEntitlements`）已有判据，但它不负责"从哪儿拿到 license"。取数面错了，
 * 后果是**静默降级或静默放行**：配了 license 却读不到 ⇒ 用户以为买了却用不了（无日志则无从查）；
 * 把"配了一半"当有效 ⇒ 该拒的放行了。故这里逐条钉死：
 *
 * 1. 未配置 ⇒ core（**不是错误**，也不该发告警）；
 * 2. 只配文本没配公钥 ⇒ core **且留痕**（半步配置是最危险的放行形态，必须可查）；
 * 3. 文件优先于内联；
 * 4. 文件超限 ⇒ **先 stat 再拒**（不读进来）+ 留痕；
 * 5. 验签失败 ⇒ 降 core + 带**授权拒因码**留痕；过期 ⇒ 降 core 但走"预期状态"事件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LICENSE_ENV_FILE,
  LICENSE_ENV_PUBLIC_KEY,
  LICENSE_ENV_TEXT,
  LicenseSource,
} from '../../src/license/licenseSource.js';
import { LicenseEngine } from '../../src/license/licenseEngine.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';

/** 采集到的事件。 */
interface Captured {
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

/**
 * 造采集器。
 * @returns 事件数组与回调
 */
function collector(): {
  readonly events: Captured[];
  readonly observe: (event: string, fields: Record<string, unknown>) => void;
} {
  const events: Captured[] = [];
  return { events, observe: (event, fields) => events.push({ event, fields }) };
}

/**
 * 造一份真实授权的文本与公钥。
 * @param opts 档位与过期时刻
 * @returns 文本与公钥
 */
function licenseOf(opts: {
  readonly tier?: 'pro' | 'team' | undefined;
  readonly expiresAtMs?: number | undefined;
}): { readonly text: string; readonly publicKeySsh: string } {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'lic-source' });
  const issuedAtMs = 1_700_000_000_000;
  const payload = {
    licenseId: 'lic-source-1',
    tier: opts.tier ?? ('team' as const),
    licensee: 'Acme',
    machineFingerprint: 'machine-src',
    issuedAtMs,
    expiresAtMs: opts.expiresAtMs ?? issuedAtMs + 86_400_000,
  };
  return {
    text: LicenseEngine.compose(payload, identity.sign(LicenseEngine.canonicalPayload(payload))),
    publicKeySsh: identity.publicKeySsh(),
  };
}

test('F4 取数 · 未配置 ⇒ core 档，且**不发**告警（没买不是错误）', () => {
  const captured = collector();
  const entitlements = LicenseSource.resolve({ env: {}, observer: captured.observe });
  assert.strictEqual(entitlements.tier, 'core');
  assert.deepStrictEqual(captured.events, [], '未配置不该产生告警噪声');
});

test('F4 取数 · 内联有效授权 ⇒ 真实档位生效', () => {
  const { text, publicKeySsh } = licenseOf({ tier: 'team' });
  const entitlements = LicenseSource.resolve({
    env: { [LICENSE_ENV_TEXT]: text, [LICENSE_ENV_PUBLIC_KEY]: publicKeySsh },
    machineFingerprint: 'machine-src',
    nowMs: 1_700_000_001_000,
  });
  assert.strictEqual(entitlements.tier, 'team');
  assert.strictEqual(entitlements.allowed('private-skill-source'), true);
});

test('F4 取数 · 只配文本没配公钥 ⇒ core **且留痕**（半步配置不得静默放行）', () => {
  const { text } = licenseOf({});
  const captured = collector();
  const entitlements = LicenseSource.resolve({
    env: { [LICENSE_ENV_TEXT]: text },
    observer: captured.observe,
  });
  assert.strictEqual(entitlements.tier, 'core');
  assert.deepStrictEqual(
    captured.events.map((entry) => [entry.event, entry.fields.missing]),
    [['license.source.rejected', LICENSE_ENV_PUBLIC_KEY]],
  );
});

test('F4 取数 · 文件优先于内联；文件超限 ⇒ 先 stat 再拒（不读进来）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lic-src-'));
  const filePath = join(dir, 'license.txt');
  const fileLicense = licenseOf({ tier: 'pro' });
  writeFileSync(filePath, fileLicense.text, 'utf8');
  const inline = licenseOf({ tier: 'team' });
  // 文件（pro）与内联（team）同时给 ⇒ 文件优先 ⇒ pro。
  const fromFile = LicenseSource.resolve({
    env: {
      [LICENSE_ENV_FILE]: filePath,
      [LICENSE_ENV_TEXT]: inline.text,
      [LICENSE_ENV_PUBLIC_KEY]: fileLicense.publicKeySsh,
    },
    machineFingerprint: 'machine-src',
    nowMs: 1_700_000_001_000,
  });
  assert.strictEqual(fromFile.tier, 'pro', '文件必须优先于内联');

  // 超限：上限设 16 字节 ⇒ 先 stat 拒，且事件带 size-limit 原因。
  const captured = collector();
  const oversize = LicenseSource.resolve({
    env: { [LICENSE_ENV_FILE]: filePath, [LICENSE_ENV_PUBLIC_KEY]: fileLicense.publicKeySsh },
    maxBytes: 16,
    observer: captured.observe,
  });
  assert.strictEqual(oversize.tier, 'core');
  assert.strictEqual(captured.events[0]?.fields.reason, 'size-limit');
});

test('F4 取数 · 验签失败 ⇒ 降 core + 带授权拒因码；过期 ⇒ 预期状态事件（不制造假告警）', () => {
  const { publicKeySsh } = licenseOf({});
  const capturedBad = collector();
  const bad = LicenseSource.resolve({
    env: {
      [LICENSE_ENV_TEXT]: 'OH-LICENSE-1\nbm90LWpzb24=\nAAAA',
      [LICENSE_ENV_PUBLIC_KEY]: publicKeySsh,
    },
    machineFingerprint: 'machine-src',
    observer: capturedBad.observe,
  });
  assert.strictEqual(bad.tier, 'core');
  assert.strictEqual(capturedBad.events[0]?.event, 'license.source.rejected');
  assert.ok(typeof capturedBad.events[0]?.fields.code === 'string');

  // 过期：同样是 core，但事件名区分开（预期状态 vs 配置问题）。
  const expired = licenseOf({ tier: 'team', expiresAtMs: 1_700_000_000_000 + 1000 });
  const capturedExpired = collector();
  const afterExpiry = LicenseSource.resolve({
    env: { [LICENSE_ENV_TEXT]: expired.text, [LICENSE_ENV_PUBLIC_KEY]: expired.publicKeySsh },
    machineFingerprint: 'machine-src',
    nowMs: 1_700_000_000_000 + 500_000,
    observer: capturedExpired.observe,
  });
  assert.strictEqual(afterExpiry.tier, 'core', '过期 ⇒ 降级为核心档（不停摆）');
  assert.strictEqual(capturedExpired.events[0]?.event, 'license.source.expired');
  assert.strictEqual(afterExpiry.allowed('harness'), true, '核心功能不受授权状态影响');
});

test('F4 取数 · 机器指纹不符 ⇒ 降 core（授权不能跨机器生效）', () => {
  const { text, publicKeySsh } = licenseOf({ tier: 'team' });
  const captured = collector();
  const other = LicenseSource.resolve({
    env: { [LICENSE_ENV_TEXT]: text, [LICENSE_ENV_PUBLIC_KEY]: publicKeySsh },
    machineFingerprint: 'another-machine',
    nowMs: 1_700_000_001_000,
    observer: captured.observe,
  });
  assert.strictEqual(other.tier, 'core');
  assert.strictEqual(captured.events[0]?.fields.code, 'machine-mismatch');
});
