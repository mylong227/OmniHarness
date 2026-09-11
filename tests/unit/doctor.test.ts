import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, isElevated } from '../../src/cli/doctorRunner.js';

test('runDoctor 返回结构包含 nodeVersion / config / sandbox / issues 字段', () => {
  const report = runDoctor();
  assert.strictEqual(typeof report.nodeVersion, 'string');
  assert.ok(report.nodeVersion.length > 0);
  assert.strictEqual(typeof report.config.exists, 'boolean');
  assert.strictEqual(typeof report.config.valid, 'boolean');
  assert.strictEqual(typeof report.sandbox.bwrap, 'boolean');
  assert.strictEqual(typeof report.sandbox.sandboxExec, 'boolean');
  assert.strictEqual(typeof report.sandbox.restrictedToken, 'boolean');
  assert.strictEqual(typeof report.pluginsDirReadable, 'boolean');
  assert.strictEqual(typeof report.permissionsManifestReadable, 'boolean');
  assert.ok(Array.isArray(report.issues));
});

test('runDoctor 在临时目录场景端到端跑通不抛，且如实报告合法配置', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-doctor-'));
  try {
    writeFileSync(join(root, 'omniharness.json'), JSON.stringify({ model: 'mock' }), 'utf8');
    writeFileSync(
      join(root, 'omniharness.permissions.json'),
      JSON.stringify({ allow: ['fs.read'] }),
      'utf8',
    );
    let report: ReturnType<typeof runDoctor> | undefined;
    assert.doesNotThrow(() => {
      report = runDoctor({ workspaceRoot: root });
    });
    assert.ok(report !== undefined);
    assert.strictEqual(report!.config.exists, true);
    assert.strictEqual(report!.config.valid, true);
    assert.strictEqual(report!.permissionsManifestReadable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDoctor 对非法配置如实报告（fail-closed，不静默）', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-doctor-bad-'));
  try {
    writeFileSync(join(root, 'omniharness.json'), '{ not valid json', 'utf8');
    const report = runDoctor({ workspaceRoot: root });
    assert.strictEqual(report.config.exists, true);
    assert.strictEqual(report.config.valid, false);
    assert.ok(report.issues.some((issue) => issue.includes('JSON 非法')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isElevated：提权探测成功→true，失败→false（注入探针，不依赖真实 OS）', () => {
  assert.strictEqual(
    isElevated(() => {}),
    true,
  );
  assert.strictEqual(
    isElevated(() => {
      throw new Error('System error 5: Access is denied');
    }),
    false,
  );
});

test('isElevated：非 Windows 平台恒为 false（短路，不跑提权探测）', () => {
  if (process.platform === 'win32') return; // 仅在非 Windows 验证平台短路
  assert.strictEqual(
    isElevated(() => {}),
    false,
  );
});
