/**
 * LinuxLandlockSandbox 单测（任务③-a/c）：**不伪造能力**，逐条验证探测与 fail-closed 原因。
 *
 * 为什么这些断言重要：本机是 Windows，landlock 永远不可达——如果判定写成「Linux 平台即可用」，
 * 在 Windows 上就会 fail-closed（看不出问题），但到了 Linux 真机上会**谎称已隔离**。
 * 故这里把「内核支持但没 helper」「helper 存在但不可执行」「非 Linux 即使有 helper 也不可用」
 * 这些边界全部钉死。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LinuxLandlockSandbox } from '../../src/adapters/sandbox/linuxLandlockSandbox.js';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.js';

/** Linux + 已启用 Landlock 内核 + 可执行 helper 的完整可用输入。 */
const AVAILABLE = {
  platform: 'linux',
  kernelRelease: '6.1.0-13-amd64',
  securityFsReadable: true,
  helperPath: '/opt/omni-landlock-helper',
  helperExecutable: true,
} as const;

describe('LinuxLandlockSandbox 严格探测', () => {
  it('本机（Windows）默认探测：不可用且原因指向 fail-closed', () => {
    const report = new LinuxLandlockSandbox(process.cwd()).probe();
    assert.strictEqual(report.platform, process.platform);
    if (process.platform !== 'linux') {
      assert.strictEqual(report.available, false);
      assert.match(report.reason, /fail-closed/);
      assert.match(report.reason, /不冒充其它后端/);
    }
    assert.strictEqual(report.helperExecutable, false, '非 Linux 上 helper 不得被判为可执行');
  });

  it('非 Linux 平台即使 helper 可执行也不可用（非目标平台不误报）', () => {
    const report = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'win32',
      kernelRelease: '6.1.0',
      securityFsReadable: false,
      helperPath: 'C:\\helper.exe',
      helperExecutable: true,
    }).probe();
    assert.strictEqual(report.available, false);
    assert.match(report.reason, /非 Linux 平台（win32）/);
    assert.match(report.reason, /profile restricted/);
  });

  it('内核版本低于 5.13：ABI 判为不支持并给出升级建议', () => {
    const report = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'linux',
      kernelRelease: '5.10.0-8-amd64',
      securityFsReadable: false,
      helperPath: null,
      helperExecutable: false,
    }).probe();
    assert.strictEqual(report.landlockAbi, null);
    assert.strictEqual(report.available, false);
    assert.match(report.reason, /需 >= 5\.13/);
    assert.match(report.reason, /CONFIG_SECURITY_LANDLOCK=y/);
  });

  it('内核支持但没有 helper：如实说明「Node 无法直调 landlock」并 fail-closed', () => {
    const report = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'linux',
      kernelRelease: '6.1.0-13-amd64',
      securityFsReadable: true,
      helperPath: null,
      helperExecutable: false,
    }).probe();
    assert.strictEqual(report.landlockAbi, 2, '6.1 → ABI 2（ABI 3 自 6.2 起）');
    assert.strictEqual(report.available, false);
    assert.match(report.reason, /OMNI_LANDLOCK_HELPER/);
    assert.match(report.reason, /landlock\(2\)/);
    assert.match(report.reason, /fail-closed/);
  });

  it('内核可见性路径不可读：判定 LSM 未启用（不放行）', () => {
    const report = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'linux',
      kernelRelease: '6.1.0-13-amd64',
      securityFsReadable: false,
      helperPath: '/opt/helper',
      helperExecutable: true,
    }).probe();
    assert.strictEqual(report.securityFsReadable, false);
    assert.strictEqual(report.available, false);
    // 关键：内核版本够 + helper 也在，但 LSM 未启用 ⇒ 依然不放行（否则就是谎称已隔离）。
    assert.match(report.reason, /\/sys\/kernel\/security\/landlock/);
    assert.match(report.reason, /lsm=/);
  });

  it('helper 路径存在但不可执行：报「不是可执行文件」而不是「未配置」', () => {
    const report = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'linux',
      kernelRelease: '6.1.0',
      securityFsReadable: true,
      helperPath: '/opt/helper',
      helperExecutable: false,
    }).probe();
    assert.strictEqual(report.available, false);
    assert.match(report.reason, /不是可执行文件/);
    assert.match(report.reason, /chmod \+x/);
  });

  it('ABI 等级按内核版本推导（5.13/5.19/6.2/6.7/6.10/6.12）', () => {
    const abi = (kernelRelease: string): number | null =>
      new LinuxLandlockSandbox(process.cwd(), {
        platform: 'linux',
        kernelRelease,
        securityFsReadable: true,
        helperPath: null,
        helperExecutable: false,
      }).probe().landlockAbi;
    assert.strictEqual(abi('5.12.9'), null);
    assert.strictEqual(abi('5.13.0'), 1);
    assert.strictEqual(abi('5.19.17'), 2);
    assert.strictEqual(abi('6.2.16'), 3);
    assert.strictEqual(abi('6.7.0'), 4);
    assert.strictEqual(abi('6.10.0'), 5);
    assert.strictEqual(abi('6.12.3'), 6);
    assert.strictEqual(abi('not-a-version'), null);
  });
});

describe('LinuxLandlockSandbox 裁决与命令行', () => {
  it('可用时：命令放行、工作区内写放行、越界写按 path 拒绝', async () => {
    const sandbox = new LinuxLandlockSandbox(process.cwd(), AVAILABLE);
    assert.strictEqual(sandbox.probe().available, true);
    assert.strictEqual((await sandbox.check({ kind: 'command', target: 'ls' })).allowed, true);
    assert.strictEqual(
      (await sandbox.check({ kind: 'file_read', target: '/etc/hosts' })).allowed,
      true,
    );
    const inside = await sandbox.check({ kind: 'file_write', target: `${process.cwd()}/a.txt` });
    assert.strictEqual(inside.allowed, true);
    const outside = await sandbox.check({ kind: 'file_write', target: '/etc/passwd' });
    assert.strictEqual(outside.allowed, false);
    assert.strictEqual(outside.category, 'path');
    assert.strictEqual(sandbox.decide({ kind: 'command', target: 'ls' }).allowed, true);
  });

  it('不可用时：check/decide 一律 fail-closed 且 category=os（附可执行原因）', async () => {
    const sandbox = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'win32',
      kernelRelease: '10.0.26100',
      securityFsReadable: false,
      helperPath: null,
      helperExecutable: false,
    });
    const viaCheck = await sandbox.check({ kind: 'command', target: 'ls' });
    assert.strictEqual(viaCheck.allowed, false);
    assert.strictEqual(viaCheck.category, 'os');
    assert.match(viaCheck.reason ?? '', /landlock 不可用/);
    assert.match(viaCheck.reason ?? '', /可执行/);
    assert.strictEqual(sandbox.decide({ kind: 'file_read', target: '/' }).allowed, false);
  });

  it('dryRun：可用时给出 helper 命令行；不可用时返回空数组（不编一个假命令）', () => {
    const available = new LinuxLandlockSandbox(process.cwd(), AVAILABLE);
    assert.deepStrictEqual(available.dryRun('ls', ['-la'], '/ws'), [
      '/opt/omni-landlock-helper',
      '--workspace',
      '/ws',
      '--',
      'ls',
      '-la',
    ]);
    const unavailable = new LinuxLandlockSandbox(process.cwd(), {
      platform: 'win32',
      helperPath: null,
      helperExecutable: false,
    });
    assert.deepStrictEqual(unavailable.dryRun('ls', [], '/ws'), []);
  });

  it('SandboxManager：landlock profile 指向真实的 linux-landlock 后端（不再是占位）', () => {
    const manager = new SandboxManager(process.cwd());
    assert.strictEqual(manager.build('landlock').name, 'linux-landlock');
  });

  it('SandboxManager：本机（Windows）landlock 仍 fail-closed（真机可达性不被谎报）', async () => {
    if (process.platform === 'linux') {
      return; // Linux 真机上的可达性由上面的注入用例覆盖
    }
    const decision = await new SandboxManager(process.cwd())
      .build('landlock')
      .check({ kind: 'command', target: 'ls' });
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.category, 'os');
  });
});
