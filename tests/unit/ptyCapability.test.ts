/**
 * PTY 能力分级单测（任务①-a/c）：完全不依赖真终端、不依赖本机是否装了 GNU `script`。
 *
 * 覆盖三件容易出真 bug 的事：
 * 1. 优先级：真 PTY 包装 > `stdio: inherit` 直通 > fail-closed（顺序不能反）；
 * 2. fail-closed 文案必须**可执行**（给出下一步），且 Windows / POSIX 分平台说明；
 * 3. argv 构造正确（含单引号转义，防注入），且不可用时**绝不**返回任何 argv。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyCapability } from '../../src/adapters/tool/shell/ptyCapability.js';

test('分级：有 script 时优先真 PTY 包装（即使父进程没有 TTY）', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: false, scriptAvailable: true });
  assert.strictEqual(report.mode, 'pty-wrapper');
  assert.strictEqual(report.available, true);
  assert.match(report.reason, /script/);
});

test('分级：无 script 但父进程有 TTY → stdio inherit 直通', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: true, scriptAvailable: false });
  assert.strictEqual(report.mode, 'inherit');
  assert.strictEqual(report.available, true);
  assert.match(report.reason, /inherit/);
});

test('分级：Windows 有 TTY 且本机无 script → 直通（不再直接 fail-closed）', () => {
  // 只注入 hasTty，scriptAvailable 走真实判定：win32 恒 false。
  const report = PtyCapability.detect({ platform: 'win32', hasTty: true });
  assert.strictEqual(report.scriptAvailable, false, 'Windows 上 script 必须判为不可用');
  assert.strictEqual(report.mode, 'inherit');
  assert.strictEqual(report.available, true);
  assert.match(report.reason, /pseudo-terminal/);
});

test('分级：无 TTY 且无 script → fail-closed（Windows 文案给可执行建议）', () => {
  const report = PtyCapability.detect({ platform: 'win32', hasTty: false, scriptAvailable: false });
  assert.strictEqual(report.mode, 'unavailable');
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /fail-closed/);
  assert.match(report.reason, /真实终端|终端/, '不可用原因必须给出可执行的补救');
  assert.match(report.reason, /不静默退化为管道/);
});

test('分级：无 TTY 且无 script → fail-closed（POSIX 文案指向 util-linux）', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: false, scriptAvailable: false });
  assert.strictEqual(report.mode, 'unavailable');
  assert.match(report.reason, /util-linux/);
  assert.match(report.reason, /fail-closed/);
});

test('argv：pty-wrapper 形态经 GNU script 包装且命令整体单引号转义', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: false, scriptAvailable: true });
  const argv = PtyCapability.argvOf('echo hi', report, '/bin/bash');
  assert.notStrictEqual(argv, null);
  assert.strictEqual(argv?.bin, 'script');
  assert.deepStrictEqual(argv?.args, ['-qec', "/bin/bash -c 'echo hi'", '/dev/null']);
});

test('argv：内嵌单引号被正确转义（不构成二次解析注入面）', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: false, scriptAvailable: true });
  const argv = PtyCapability.argvOf("echo 'a b'", report, '/bin/bash');
  const inner = argv?.args[1] ?? '';
  assert.ok(inner.includes("'\\''"), `应使用标准 '\\'' 转义，实得：${inner}`);
  assert.strictEqual(inner, "/bin/bash -c 'echo '\\''a b'\\'''");
});

test('argv：inherit 形态直接继承父进程终端（POSIX 用 -c）', () => {
  const report = PtyCapability.detect({ platform: 'linux', hasTty: true, scriptAvailable: false });
  const argv = PtyCapability.argvOf('vim /tmp/x', report, '/bin/bash');
  assert.deepStrictEqual(argv, { bin: '/bin/bash', args: ['-c', 'vim /tmp/x'] });
});

test('argv：inherit 形态在 Windows 上按 cmd 语义构造（/d /s /c + 整体引号）', () => {
  const report = PtyCapability.detect({ platform: 'win32', hasTty: true });
  const argv = PtyCapability.argvOf('vim x.txt', report, 'cmd.exe');
  // 2026-09-24 更新（审计 §1.9）：命令串必须**整体再包一层引号**——`cmd /s` 会剥掉这一层，
  // 从而把命令原文原样交给 cmd；spawn 侧配套 `windowsVerbatimArguments`
  // （见 ShellInvocation.needsVerbatimArgs）。旧的无引号形态会让带引号参数粘成一个。
  assert.deepStrictEqual(argv, { bin: 'cmd.exe', args: ['/d', '/s', '/c', '"vim x.txt"'] });
});

test('argv：不可用时返回 null（绝不退化成管道 argv）', () => {
  const report = PtyCapability.detect({ platform: 'win32', hasTty: false, scriptAvailable: false });
  assert.strictEqual(PtyCapability.argvOf('vim', report, 'cmd.exe'), null);
});

test('scriptAvailable：win32 恒 false；候选目录可注入且不 spawn 任何进程', () => {
  assert.strictEqual(PtyCapability.scriptAvailable('win32'), false);
  assert.strictEqual(PtyCapability.scriptAvailable('linux', []), false, '空候选目录 → 找不到');
  assert.strictEqual(
    PtyCapability.scriptAvailable('linux', ['/definitely/not/here']),
    false,
    '不存在的目录 → 找不到（且不得抛错）',
  );
});

test('真实环境探测：结论自洽且不抛错', () => {
  const report = PtyCapability.detect();
  assert.strictEqual(report.platform, process.platform);
  assert.strictEqual(report.available, report.mode !== 'unavailable');
  assert.ok(report.reason.length > 0);
  if (report.mode === 'inherit') {
    assert.strictEqual(report.hasTty, true, 'inherit 形态必须真的持有 TTY');
  }
  if (report.mode === 'pty-wrapper') {
    assert.strictEqual(report.scriptAvailable, true);
  }
});
