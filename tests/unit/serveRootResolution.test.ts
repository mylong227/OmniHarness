/**
 * 工作区根解析：**显式 --workspace > 本机固定项目 > 启动目录**（2026-10-06 用户口径）。
 *
 * ## 为什么（用户原话）
 *
 * "私密配置落在本地文件夹内，不能随项目上传；要求固定项目启动读取，可配置的；
 *  保证以后无论如何启动项目都能正确的读取到配置，无论什么条件下启动都能正常读取到项目配置。"
 *
 * 旧行为只认启动目录（`cd 项目 && serve`），于是"配置里记着的项目"在从别处启动时被**静默忽略**
 * ——用起来就像"项目读不到"。新口径把"当前项目"当**本机运行态**：落在用户级配置，serve 从任何
 * 目录启动都读得到，且启动横幅会说明来源。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 显式 `--workspace` 恒优先（脚本/CI 可复现） |
 * | ② | 无显式旗标时用**本机固定项目**，且**与 cwd 无关**（同样两个目录轮换启动，结果一致） |
 * | ③ | 本机记的项目路径已不存在 ⇒ 回落启动目录，并如实标注 `local-missing`（不许指向幽灵路径） |
 * | ④ | 本机没有记项目 ⇒ 启动目录（老行为不破） |
 * | ⑤ | **写路径**：切换项目只写**用户级**配置；项目文件里**不得**出现 `workspace`/`workspaces`（不随项目上传） |
 * | ⑥ | 切换后**从另一个目录**再起（新实例、同一 userHomedir）⇒ 仍读到被固定的项目 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServeWorkspace } from '../../src/cli/serveWorkspace.js';
import { ArgParser } from '../../src/cli/argParser.js';
import { PortablePath } from '../../src/util/portablePath.js';
import { ServerConfigStore } from '../../src/server/services/serverConfigStore.js';

/** `serveRootOf` 的分隔符恒为 `/`（PortablePath 口径）；比较前统一，避免平台差异造成假红。 */
const norm = (p: string): string => p.replace(/\\/g, '/');

/** 造一个"本机家目录 + 项目目录"的隔离夹具。 */
function fixture(): {
  home: string;
  project: string;
  otherCwd: string;
  writeLocal: (patch: Record<string, unknown>) => void;
  store: (configPath: string) => ServerConfigStore;
} {
  const home = mkdtempSync(join(tmpdir(), 'omni-root-home-'));
  const project = mkdtempSync(join(tmpdir(), 'omni-root-proj-'));
  const otherCwd = mkdtempSync(join(tmpdir(), 'omni-root-cwd-'));
  mkdirSync(join(home, '.omniharness'), { recursive: true });
  const writeLocal = (patch: Record<string, unknown>): void => {
    writeFileSync(
      join(home, '.omniharness', 'omniharness.json'),
      JSON.stringify({ modelAdapter: 'openai', providerKeys: { deepseek: 'sk-test' }, ...patch }),
      'utf8',
    );
  };
  const store = (configPath: string): ServerConfigStore =>
    new ServerConfigStore({
      displayConfig: { workspace: project },
      configPath,
      autoApprove: false,
      probeProvider: () => Promise.resolve(),
      onChanged: () => undefined,
      userHomedir: home,
    });
  return { home, project, otherCwd, writeLocal, store };
}

test('① 显式 --workspace 恒优先（哪怕本机固定项目是另一个）', () => {
  const { home, project, otherCwd, writeLocal } = fixture();
  try {
    writeLocal({ workspace: project });
    const picked = ServeWorkspace.serveRootOf(otherCwd, otherCwd, home);
    assert.strictEqual(norm(picked.root), norm(otherCwd));
    assert.strictEqual(picked.source, 'flag');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('② 本机固定项目：从任意目录启动结果一致（与 cwd 无关）', () => {
  const { home, project, otherCwd, writeLocal } = fixture();
  try {
    writeLocal({ workspace: project });
    const fromProject = ServeWorkspace.serveRootOf(undefined, project, home);
    const fromElsewhere = ServeWorkspace.serveRootOf(undefined, otherCwd, home);
    assert.strictEqual(norm(fromProject.root), norm(project));
    assert.strictEqual(
      norm(fromElsewhere.root),
      norm(project),
      '换个目录启动就找不到项目 ⇒ 正是用户抱怨的现象',
    );
    assert.strictEqual(fromElsewhere.source, 'local');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('③ 本机记的项目路径已不存在 ⇒ 回落启动目录且如实标注 local-missing', () => {
  const { home, otherCwd, writeLocal } = fixture();
  try {
    writeLocal({ workspace: join(home, 'deleted-project') });
    const picked = ServeWorkspace.serveRootOf(undefined, otherCwd, home);
    assert.strictEqual(norm(picked.root), norm(otherCwd));
    assert.strictEqual(picked.source, 'local-missing');
    assert.match(ServeWorkspace.describeRootSource(picked.source), /不存在/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('④ 本机没有记项目 ⇒ 启动目录（老行为不破）', () => {
  const { home, otherCwd, writeLocal } = fixture();
  try {
    writeLocal({});
    const picked = ServeWorkspace.serveRootOf(undefined, otherCwd, home);
    assert.strictEqual(norm(picked.root), norm(otherCwd));
    assert.strictEqual(picked.source, 'cwd');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('⑤ 切换项目只写用户级配置：项目文件里不得出现 workspace/workspaces', () => {
  const { home, project, store } = fixture();
  const configPath = join(project, 'omniharness.json');
  try {
    writeFileSync(configPath, JSON.stringify({ approval: 'rules' }), 'utf8');
    const s = store(configPath);
    s.commitWorkspaceSwitch(project, 'D:/some/previous/project');
    const local = JSON.parse(
      readFileSync(join(home, '.omniharness', 'omniharness.json'), 'utf8'),
    ) as { workspace?: string; workspaces?: string[] };
    assert.strictEqual(local.workspace, project, '当前项目必须落用户级（本机运行态）');
    assert.ok(
      Array.isArray(local.workspaces) && local.workspaces.includes('D:/some/previous/project'),
      '切走前的项目要一并收编进本机列表',
    );
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.strictEqual(
      persisted['workspace'],
      undefined,
      '项目文件被写进了本机运行态（会随项目上传）',
    );
    assert.strictEqual(persisted['workspaces'], undefined, '项目文件被写进了项目列表');
    assert.ok(existsSync(configPath));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('⑥ 切换后从另一个目录再起：仍读到被固定的项目', () => {
  const { home, project, otherCwd, store } = fixture();
  const configPath = join(project, 'omniharness.json');
  try {
    writeFileSync(configPath, JSON.stringify({ approval: 'rules' }), 'utf8');
    store(configPath).commitWorkspaceSwitch(project, otherCwd);
    // 新实例（模拟重启）＋ 从另一个目录启动（模拟"无论什么条件下启动"）
    const picked = ServeWorkspace.serveRootOf(undefined, otherCwd, home);
    assert.strictEqual(norm(picked.root), norm(project));
    assert.strictEqual(picked.source, 'local');
    const fresh = store(join(otherCwd, 'omniharness.json'));
    assert.strictEqual(norm(fresh.workspaces().current), norm(project));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test('⑦ 可移植路径：同一份配置在任何机器/用户下都展开到本机真实目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-portable-home-'));
  try {
    mkdirSync(join(home, 'work', 'proj'), { recursive: true });
    const env = {
      USERPROFILE: home,
      HOME: home,
      OMNI_PROJECTS: join(home, 'work'),
    } as NodeJS.ProcessEnv;
    const want = join(home, 'work', 'proj').replace(/\\/g, '/').toLowerCase();
    for (const raw of [
      '~/work/proj',
      '$HOME/work/proj',
      '${HOME}/work/proj',
      '%USERPROFILE%\\work\\proj',
      '$OMNI_PROJECTS/proj',
      'work/proj',
    ]) {
      assert.strictEqual(
        PortablePath.expand(raw, home, env).toLowerCase(),
        want,
        `展开不符：${raw}`,
      );
    }
    // 未知变量**不许猜**（保持字面量，由存在性检查如实失败）
    assert.match(PortablePath.expand('$OMNI_NOT_SET/x', home, env), /\$OMNI_NOT_SET/);
    // 写回：家目录下的路径压成 `~/…`（跨机器成立）；家目录外的保持绝对（不臆造）
    assert.strictEqual(PortablePath.compact(join(home, 'work', 'proj'), home), '~/work/proj');
    assert.strictEqual(PortablePath.compact('D:/work/新项目', home), 'D:/work/新项目');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('⑧ 可移植的固定项目：从任意 cwd 启动都解析到同一目录；路径没了也不阻断启动', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-portable-home8-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'omni-portable-cwd8-'));
  try {
    mkdirSync(join(home, '.omniharness'), { recursive: true });
    mkdirSync(join(home, 'work', 'proj'), { recursive: true });
    // 配置里写的是**可移植形态**，不是某个磁盘的绝对路径
    writeFileSync(
      join(home, '.omniharness', 'omniharness.json'),
      JSON.stringify({ workspace: '~/work/proj' }),
      'utf8',
    );
    const picked = ServeWorkspace.serveRootOf(undefined, elsewhere, home);
    assert.strictEqual(picked.source, 'local');
    assert.strictEqual(
      picked.root.toLowerCase(),
      join(home, 'work', 'proj').replace(/\\/g, '/').toLowerCase(),
    );
    // 该路径在本机不存在时：**不阻断启动**，回落启动目录并如实标注
    writeFileSync(
      join(home, '.omniharness', 'omniharness.json'),
      JSON.stringify({ workspace: '~/work/not-here' }),
      'utf8',
    );
    const fallback = ServeWorkspace.serveRootOf(undefined, elsewhere, home);
    assert.strictEqual(fallback.source, 'local-missing');
    assert.strictEqual(norm(fallback.root), norm(elsewhere));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('⑩ 显式旗标判定看“旗标出现”，而不是解析后的默认值（CliDefaults.workspace 恒为 cwd）', () => {
  assert.strictEqual(ServeWorkspace.explicitWorkspaceOf([]), undefined);
  assert.strictEqual(ServeWorkspace.explicitWorkspaceOf(['--port', '1']), undefined);
  assert.strictEqual(ServeWorkspace.explicitWorkspaceOf(['--workspace', 'D:/p']), 'D:/p');
  assert.strictEqual(ServeWorkspace.explicitWorkspaceOf(['--workspace=D:/p']), 'D:/p');
  // 对照：解析结果里的 workspace **永远**是字符串——这正是不能用它判断"用户给了吗"的原因
  const parsed = ArgParser.parseArgs(['--prompt', 'serve']);
  assert.strictEqual(typeof parsed?.workspace, 'string');
});
