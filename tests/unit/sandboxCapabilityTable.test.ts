/**
 * SandboxCapabilityTable 单测（任务③-b/c）：统一能力自述的判定与输出。
 *
 * 重点验证三件事：
 * 1. 本机（Windows）下各后端的判定正确——策略类可达、OS 级不可达；
 * 2. **非目标平台不误报可用**（在 Windows 上不能说 seatbelt/bwrap/unshare 可达）；
 * 3. 不可用项必须给可执行原因，且能被 `doctor` 直接打印出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxCapabilityTable } from '../../src/adapters/sandbox/sandboxCapabilityTable.js';
import type { SandboxCapabilityEntry } from '../../src/adapters/sandbox/sandboxCapabilityTable.js';

/** 取一条条目（不存在即测试失败）。 */
const entryOf = (
  entries: readonly SandboxCapabilityEntry[],
  profile: string,
): SandboxCapabilityEntry => {
  const found = entries.find((entry) => entry.profile === profile);
  assert.ok(found !== undefined, `能力表缺少 profile ${profile}`);
  return found;
};

/** 全部命令都「存在」的注入判定（用于隔离平台维度的影响）。 */
const allCommands = (): boolean => true;

/** 全部命令都不存在的注入判定。 */
const noCommands = (): boolean => false;

test('本机能力表：7 条 profile 齐全、backend 名如实、平台不对的绝不报可达', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd());
  assert.deepStrictEqual(
    entries.map((entry) => entry.profile),
    [...SandboxCapabilityTable.PROFILES],
  );
  assert.strictEqual(entryOf(entries, 'landlock').backend, 'linux-landlock');
  assert.strictEqual(entryOf(entries, 'seatbelt').backend, 'macos-seatbelt');
  assert.strictEqual(entryOf(entries, 'bwrap').backend, 'linux-bwrap');
  assert.strictEqual(entryOf(entries, 'unshare').backend, 'linux-unshare');

  // 策略类：不依赖 OS，任何平台都真机可达。
  for (const profile of ['passthrough', 'policy', 'restricted']) {
    assert.strictEqual(entryOf(entries, profile).real, true, `${profile} 应在任何平台可达`);
  }
  // 非目标平台：不得误报。
  if (process.platform !== 'darwin') {
    assert.strictEqual(entryOf(entries, 'seatbelt').real, false);
  }
  if (process.platform !== 'linux') {
    assert.strictEqual(entryOf(entries, 'bwrap').real, false);
    assert.strictEqual(entryOf(entries, 'unshare').real, false);
    assert.strictEqual(entryOf(entries, 'landlock').real, false);
  }
});

test('不变量：每条都有依据；不可达项必须给可执行补救', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd());
  for (const entry of entries) {
    assert.ok(entry.basis.length > 0, `${entry.profile} 缺依据`);
    if (!entry.real) {
      assert.ok(entry.actionable.length > 0, `${entry.profile} 不可达但没给补救`);
    }
  }
});

test('注入 platform=win32 且命令全在：Linux/macOS 后端一律不可达（非目标平台不误报）', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'win32',
    commandExists: allCommands,
  });
  for (const profile of ['seatbelt', 'bwrap', 'unshare'] as const) {
    const entry = entryOf(entries, profile);
    assert.strictEqual(entry.real, false, `win32 上 ${profile} 不得报可达`);
    assert.match(entry.basis, /非目标平台|仅 (darwin|linux) 可用/);
  }
  assert.strictEqual(entryOf(entries, 'landlock').real, false);
});

test('注入 platform=linux 且命令全在：bwrap/unshare 可达，seatbelt 不可达', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'linux',
    commandExists: allCommands,
  });
  assert.strictEqual(entryOf(entries, 'bwrap').real, true);
  assert.strictEqual(entryOf(entries, 'unshare').real, true);
  assert.strictEqual(entryOf(entries, 'seatbelt').real, false);
  assert.match(entryOf(entries, 'bwrap').basis, /PATH 上可找到/);
});

test('注入 platform=darwin 且命令全在：seatbelt 可达，Linux 后端不可达', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'darwin',
    commandExists: allCommands,
  });
  assert.strictEqual(entryOf(entries, 'seatbelt').real, true);
  assert.strictEqual(entryOf(entries, 'bwrap').real, false);
  assert.strictEqual(entryOf(entries, 'unshare').real, false);
});

test('平台对但二进制缺失：不可达 + 安装提示（Linux 上没装 bubblewrap 的情形）', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'linux',
    commandExists: noCommands,
  });
  const bwrap = entryOf(entries, 'bwrap');
  assert.strictEqual(bwrap.real, false);
  assert.match(bwrap.basis, /找不到 `bwrap`/);
  assert.match(bwrap.basis, /fail-closed/);
  assert.match(bwrap.actionable, /bubblewrap/);
});

test('Landlock 条目：判定委托给后端探测报告（同源，不另写一套）', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'linux',
    commandExists: allCommands,
    landlock: {
      available: true,
      platform: 'linux',
      kernelRelease: '6.12.0',
      landlockAbi: 6,
      securityFsPath: '/sys/kernel/security/landlock',
      securityFsReadable: true,
      helperPath: '/opt/helper',
      helperExecutable: true,
      reason: '内核支持 Landlock（ABI 6）且 helper 可执行',
    },
  });
  const landlock = entryOf(entries, 'landlock');
  assert.strictEqual(landlock.real, true);
  assert.match(landlock.basis, /ABI 6/);
  assert.strictEqual(landlock.actionable, '');
});

test('restricted 条目如实说明 Windows 侧的提权前提', () => {
  const elevated = entryOf(
    SandboxCapabilityTable.describe(process.cwd(), { platform: 'win32', elevated: true }),
    'restricted',
  );
  assert.match(elevated.basis, /已提权/);
  const plain = entryOf(
    SandboxCapabilityTable.describe(process.cwd(), { platform: 'win32', elevated: false }),
    'restricted',
  );
  assert.match(plain.basis, /未提权/);
  assert.match(plain.actionable, /管理员权限/);
});

test('format：表格可直接打印，含表头/可达列/不可达项的可执行补救', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'win32',
    commandExists: noCommands,
    elevated: false,
  });
  const text = SandboxCapabilityTable.format(entries);
  assert.match(text, /沙箱后端能力表/);
  assert.match(text, /passthrough/);
  assert.match(text, /可达/);
  assert.match(text, /不可达/);
  assert.match(text, /↳ 可执行：/);
  assert.match(text, /fail-closed/);
  assert.strictEqual(text.split('\n').length > entries.length, true, '不可达项应有额外说明行');
});

test('format：可达项只出「提示」行，不可达项才出「可执行」行（一一对应）', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), {
    platform: 'linux',
    commandExists: allCommands,
    landlock: {
      available: true,
      platform: 'linux',
      kernelRelease: '6.12.0',
      landlockAbi: 6,
      securityFsPath: '/sys/kernel/security/landlock',
      securityFsReadable: true,
      helperPath: '/opt/helper',
      helperExecutable: true,
      reason: '内核支持 Landlock（ABI 6）且 helper 可执行',
    },
  });
  const lines = SandboxCapabilityTable.format(entries).split('\n');
  const unreachable = entries.filter((entry) => !entry.real).length;
  assert.strictEqual(
    lines.filter((line) => line.includes('↳ 可执行：')).length,
    unreachable,
    '每个不可达项恰好一条可执行补救（不多不少）',
  );
  assert.ok(
    lines.some((line) => line.includes('↳ 提示：')),
    '可达但带提示的项（如 passthrough）应出提示行',
  );
});
