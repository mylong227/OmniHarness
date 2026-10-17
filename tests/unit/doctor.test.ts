import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorRunner } from '../../src/cli/doctorRunner.js';

test('runDoctor 返回结构包含 nodeVersion / config / sandbox / issues 字段', () => {
  const report = DoctorRunner.runDoctor();
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
    let report: ReturnType<typeof DoctorRunner.runDoctor> | undefined;
    assert.doesNotThrow(() => {
      report = DoctorRunner.runDoctor({ workspaceRoot: root });
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
    const report = DoctorRunner.runDoctor({ workspaceRoot: root });
    assert.strictEqual(report.config.exists, true);
    assert.strictEqual(report.config.valid, false);
    assert.ok(report.issues.some((issue) => issue.includes('JSON 非法')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exitCode：0 ⇔ 无问题项 / 1 ⇔ 有问题项（合成报告，两台机器都判得动）', () => {
  // 为什么用**合成报告**而不是"跑一次 doctor 看退出码"：本机健康与否是环境事实
  //（缺插件目录 / 无 OS 沙箱后端都是合法状态），拿它当判据等于把机器状态写进契约
  // ——本仓为此假红过一条判据（`cliLocalCommands.test.ts` ①，2026-10-15 修）。
  const real = DoctorRunner.runDoctor();
  const clean = { ...real, issues: [] };
  const dirty = { ...real, issues: ['合成问题：用于钉死映射'] };

  assert.strictEqual(DoctorRunner.exitCode(clean), 0, '没有问题项必须 0');
  assert.strictEqual(
    DoctorRunner.exitCode(dirty),
    1,
    '有问题项必须非零（否则 `doctor && 下一步` 会把坏环境当好的用）',
  );
  // 正对照：同一份报告只改 issues 一个字段 ⇒ 退出码必须跟着变（防"恒 0 或恒 1"的退化实现）。
  assert.notStrictEqual(DoctorRunner.exitCode(clean), DoctorRunner.exitCode(dirty));
  // 与真实报告的一致性：真跑出来的报告，退出码必须与它自己的问题清单一致。
  assert.strictEqual(DoctorRunner.exitCode(real), real.issues.length === 0 ? 0 : 1);
});

test(
  'isElevated：提权探测成功→true，失败→false（注入探针，不依赖真实 OS）',
  { skip: process.platform !== 'win32' },
  () => {
    // 注入探针语义只在 Windows 提权路径上生效；非 Windows 平台 isElevated 先短路返回 false
    //（下一例专测短路），故本例必须平台门禁——否则 CI 上 ubuntu/macos 必红（首跑实证）。
    assert.strictEqual(
      DoctorRunner.isElevated(() => {}),
      true,
    );
    assert.strictEqual(
      DoctorRunner.isElevated(() => {
        throw new Error('System error 5: Access is denied');
      }),
      false,
    );
  },
);

test('isElevated：非 Windows 平台恒为 false（短路，不跑提权探测）', () => {
  if (process.platform === 'win32') return; // 仅在非 Windows 验证平台短路
  assert.strictEqual(
    DoctorRunner.isElevated(() => {}),
    false,
  );
});
