/**
 * 容器沙箱（P2-2）判据：可选 Docker/Podman 档、非默认、缺运行时 fail-closed。
 *
 * 重点覆盖：
 * 1. 不可用（注入）时**一切动作**拒绝且归 `os`，原因可行动；
 * 2. 工作区内读/写放行，越界（绝对/相对两种写法）一律 `path` 拒绝；
 * 3. `wrapCommand` 的隔离意图真的出现在命令里（断网/清 capability/只读根/tmpfs/挂载/cwd）；
 * 4. 引号：POSIX 单引号转义、Windows 路径含空格与内嵌引号；
 * 5. 接线：SandboxManager / ConfigError / CLI 枚举 / 帮助 / 能力表 / argv 解析。
 *
 * 全部用例都注入 `available` 或显式 `platform`，不依赖本机是否装 Docker——判据必须可复现。
 */
import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerSandbox } from '../../src/adapters/sandbox/containerSandbox.ts';
import { SandboxCapabilityTable } from '../../src/adapters/sandbox/sandboxCapabilityTable.ts';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.ts';
import { SANDBOX_PROFILES } from '../../src/cli/cliEnums.ts';
import { ArgParser } from '../../src/cli/argParser.ts';
import { cliHelp } from '../../src/cli/cliHelp.ts';
import { ConfigError } from '../../src/config/configError.ts';
import { PosixShell } from '../../src/util/posixShell.ts';

/** 临时工作区（目录名刻意含空格，覆盖 Windows `-v` 引号场景）。 */
const roots: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni container '));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'inside.txt'), 'ok');
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('不可用（注入 available=false）：命令/读/写一律 fail-closed 且归 os，原因可行动', async () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: false });
  const actions = [
    { kind: 'command', target: 'ls' },
    { kind: 'file_read', target: join(root, 'inside.txt') },
    { kind: 'file_write', target: join(root, 'inside.txt') },
  ] as const;
  for (const action of actions) {
    const decision = await sandbox.check(action);
    assert.strictEqual(decision.allowed, false, `${action.kind} 在运行时不可用时必须拒绝`);
    assert.strictEqual(decision.category, 'os', '拒绝必须诚实归类为 os');
    assert.match(decision.reason ?? '', /fail-closed/);
    assert.match(decision.reason ?? '', /安装 Docker|podman/, '原因必须可行动（装运行时）');
  }
});

test('缺省可用性探测：dockerBin 不存在时真实 `version` 探测失败 → available()=false', () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({
    workspaceRoot: root,
    dockerBin: 'omni-container-runtime-does-not-exist',
  });
  assert.strictEqual(sandbox.available(), false, '探测失败必须是 false（fail-closed 的前提）');
});

test('工作区内 read/write 放行；命令放行并说明默认断网 + 只读根 + workspace rw', async () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  assert.strictEqual(
    (await sandbox.check({ kind: 'file_read', target: join(root, 'inside.txt') })).allowed,
    true,
  );
  assert.strictEqual(
    (await sandbox.check({ kind: 'file_write', target: 'new-file.txt' })).allowed,
    true,
    '相对路径按 workspace 解析后应放行',
  );
  const command = await sandbox.check({ kind: 'command', target: 'rm -rf /' });
  assert.strictEqual(command.allowed, true, '命令由容器隔离，不做策略黑名单');
  assert.match(command.reason ?? '', /默认断网/);
  assert.match(command.reason ?? '', /只读/);
  assert.match(command.reason ?? '', /rw 挂载/);
});

test('越界路径：绝对路径与 `..` 相对路径都被 path 类拒绝（读/写一致）', async () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  const outside = join(tmpdir(), `omni-container-outside-${Date.now()}.txt`);
  for (const kind of ['file_read', 'file_write'] as const) {
    for (const target of [outside, '../escape.txt']) {
      const decision = await sandbox.check({ kind, target });
      assert.strictEqual(decision.allowed, false, `${kind} 越界必须拒绝：${target}`);
      assert.strictEqual(decision.category, 'path');
      assert.match(decision.reason ?? '', /workspace/);
    }
  }
});

test('wrapCommand 含完整隔离参数：断网/清 capability/禁提权/只读根/tmpfs/挂载/资源上限', () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  const wrapped = sandbox.wrapCommand('echo hi', root, 'linux');
  assert.match(wrapped, /--rm/);
  assert.match(wrapped, /--init/);
  assert.match(wrapped, /--network none/);
  assert.match(wrapped, /--cap-drop ALL/);
  assert.match(wrapped, /--security-opt no-new-privileges/);
  assert.match(wrapped, /--read-only/);
  assert.match(wrapped, /--tmpfs \/tmp/);
  assert.match(wrapped, /--memory 512m/);
  assert.match(wrapped, /--pids-limit 256/);
  assert.ok(wrapped.includes(`${root}:/workspace`), '必须把 workspace 挂到 /workspace');
  assert.match(wrapped, /sh -lc 'echo hi'$/);
});

test('wrapCommand：cwd 映射到 /workspace/<rel>，根目录为 /workspace，越界抛错', () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  assert.match(sandbox.wrapCommand('ls', root, 'linux'), /-w \/workspace/);
  assert.match(sandbox.wrapCommand('ls', join(root, 'sub'), 'linux'), /-w \/workspace\/sub/);
  assert.throws(
    () => sandbox.wrapCommand('ls', join(root, '..'), 'linux'),
    /不在 workspace/,
    'cwd 越界必须 fail-closed',
  );
});

test("引号：POSIX 单引号转义为 `'\\''`，命令文本原样作为单个 sh -lc 参数", () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  assert.strictEqual(PosixShell.quote("it's"), "'it'\\''s'");
  const wrapped = sandbox.wrapCommand("echo 'a b'", root, 'linux');
  assert.ok(
    wrapped.endsWith(PosixShell.quote("echo 'a b'")),
    "容器侧命令必须整体单引号包裹，内部单引号以 '\\'' 转义",
  );
  assert.ok(
    wrapped.endsWith("'echo '\\''a b'\\'''"),
    "单引号转义的字面形态必须是 `'\\''`（shell 可还原的唯一样式）",
  );
});

test('Windows：含空格的 workspace 与内嵌引号的命令都按 argv 规则加双引号', () => {
  const root = makeWorkspace();
  const sandbox = new ContainerSandbox({ workspaceRoot: root, available: true });
  const wrapped = sandbox.wrapCommand('echo "hi"', join(root, 'sub'), 'win32');
  assert.ok(wrapped.includes(`"${root}:/workspace"`), '挂载路径（含空格）必须整段加双引号');
  assert.ok(wrapped.includes('-w /workspace/sub'), '容器内 cwd 必须是单个参数');
  assert.ok(wrapped.endsWith('"echo \\"hi\\""'), '内嵌双引号必须转义，不被 cmd 拆参');
});

test('接线：SandboxManager.build(container)、非未接线、--sandbox container 可解析', () => {
  const root = makeWorkspace();
  const manager = new SandboxManager(root);
  assert.strictEqual(manager.build('container').name, 'container');
  assert.strictEqual(SandboxManager.isExecutionUnwired('container'), false, 'wrapCommand 已接');
  assert.strictEqual(
    ArgParser.parseArgs(['--prompt', 'hi', '--sandbox', 'container'])?.sandbox,
    'container',
  );
});

test('接线：ConfigError 接受 container，CLI 帮助枚举自动跟随', () => {
  assert.doesNotThrow(() => ConfigError.validateConfig({ sandbox: 'container' }));
  assert.ok((SANDBOX_PROFILES as readonly string[]).includes('container'));
  const sandboxLine = cliHelp
    .render()
    .split('\n')
    .find((line) => line.trimStart().startsWith('--sandbox'));
  assert.ok(sandboxLine !== undefined, '帮助里应有 --sandbox 条目');
  assert.ok(sandboxLine.includes('container'), 'CLI 帮助的 profile 枚举应自动包含 container');
});

test('能力表：container 条目按 docker/podman 判定，不可用时给安装补救', () => {
  const root = makeWorkspace();
  assert.ok((SandboxCapabilityTable.PROFILES as readonly string[]).includes('container'));

  const withRuntime = SandboxCapabilityTable.describe(root, {
    platform: 'win32',
    commandExists: (command) => command === 'podman',
  });
  const reachable = withRuntime.find((entry) => entry.profile === 'container');
  assert.ok(reachable !== undefined, '能力表必须包含 container');
  assert.strictEqual(reachable.backend, 'container');
  assert.strictEqual(reachable.real, true, 'podman 在 PATH 上即视为运行时可达');
  assert.match(reachable.basis, /podman/);
  assert.match(reachable.basis, /不是 microVM|不 spawn/, '必须如实说明探测边界');

  const withoutRuntime = SandboxCapabilityTable.describe(root, {
    platform: 'win32',
    commandExists: () => false,
  });
  const unreachable = withoutRuntime.find((entry) => entry.profile === 'container');
  assert.ok(unreachable !== undefined);
  assert.strictEqual(unreachable.real, false);
  assert.match(unreachable.actionable, /安装 Docker|podman/);
  assert.match(unreachable.basis, /fail-closed/);
});

test('默认镜像：OMNI_CONTAINER_IMAGE 优先，空值回落到 node:22-alpine', () => {
  const root = makeWorkspace();
  const saved = process.env['OMNI_CONTAINER_IMAGE'];
  try {
    process.env['OMNI_CONTAINER_IMAGE'] = 'ghcr.io/example/dev:1';
    const custom = new ContainerSandbox({ workspaceRoot: root, available: true });
    assert.match(custom.wrapCommand('true', root, 'linux'), /ghcr\.io\/example\/dev:1/);

    process.env['OMNI_CONTAINER_IMAGE'] = '';
    const fallback = new ContainerSandbox({ workspaceRoot: root, available: true });
    assert.match(fallback.wrapCommand('true', root, 'linux'), /node:22-alpine/);
  } finally {
    if (saved === undefined) delete process.env['OMNI_CONTAINER_IMAGE'];
    else process.env['OMNI_CONTAINER_IMAGE'] = saved;
  }
});
