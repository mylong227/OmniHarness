/**
 * 自验证命令探测单测：把「非 npm 仓库永远不启用自验证」这条缺口钉死。
 *
 * 原实现把「仓库有测试症状」等价于「`package.json` 含 `scripts.test`」⇒ Python / Rust /
 * Go / Java 仓库里 `SelfVerifyPolicy.SOURCE_EXTENSIONS` 里的 `.py/.rs/.go/.java` 是
 * **不可达判据**；且**显式 `selfVerify.command` 也被同一道闸门挡下**。本测试同时覆盖：
 * ① 各生态证据 → 命令；② 优先级（多生态并存时取首个）；③ 显式命令绕过闸门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SelfVerifyCommandDetector } from '../../src/adapters/tool/verify/selfVerifyCommandDetector.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';

/**
 * 造一个临时仓库（按相对路径写入文件，目录自动创建）。
 *
 * @param files 相对路径 → 文件内容。
 * @returns 仓库根绝对路径。
 */
const makeRepo = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'omni-selfverify-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
};

/** 删除临时仓库（失败不抛，避免污染断言结果）。 */
const dropRepo = (root: string): void => {
  rmSync(root, { recursive: true, force: true });
};

test('探测：各生态的测试症状映射到对应测试命令', () => {
  const cases: readonly (readonly [
    string,
    Readonly<Record<string, string>>,
    string | undefined,
  ])[] = [
    ['npm', { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, 'npm test'],
    [
      'npm 无 test 脚本',
      { 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) },
      undefined,
    ],
    ['package.json 非法 JSON', { 'package.json': '{ 这不是 json' }, undefined],
    ['pytest.ini', { 'pytest.ini': '[pytest]\n' }, 'pytest -q'],
    ['pyproject 含 pytest', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, 'pytest -q'],
    ['setup.cfg 测试段', { 'setup.cfg': '[tool:pytest]\n' }, 'pytest -q'],
    ['conftest.py', { 'conftest.py': '' }, 'pytest -q'],
    ['tests/test_x.py', { 'tests/test_x.py': 'def test_a():\n    pass\n' }, 'pytest -q'],
    ['test/x_test.py', { 'test/x_test.py': 'def test_a():\n    pass\n' }, 'pytest -q'],
    ['仅 pyproject 无 pytest', { 'pyproject.toml': '[project]\nname="x"\n' }, undefined],
    ['cargo', { 'Cargo.toml': '[package]\nname="x"\n' }, 'cargo test'],
    ['go', { 'go.mod': 'module x\n' }, 'go test ./...'],
    ['maven', { 'pom.xml': '<project/>' }, 'mvn -q test'],
    ['gradle(groovy)', { 'build.gradle': 'plugins {}\n' }, 'gradle test'],
    ['gradle(kts)', { 'build.gradle.kts': 'plugins {}\n' }, 'gradle test'],
    [
      'rspec',
      { Gemfile: 'source "https://rubygems.org"\n', 'spec/a_spec.rb': '' },
      'bundle exec rspec',
    ],
    ['Gemfile 但无 spec 证据', { Gemfile: 'source "x"\n' }, undefined],
    ['dotnet(sln)', { 'App.sln': '' }, 'dotnet test'],
    ['dotnet(csproj)', { 'App.csproj': '<Project/>' }, 'dotnet test'],
    ['make test', { Makefile: 'build:\n\techo b\ntest:\n\techo t\n' }, 'make test'],
    ['make 无 test 目标', { Makefile: 'build:\n\techo b\n' }, undefined],
    // 保守口径：`test:` 必须真的是**目标**。以下三类看着像、其实不是，
    // 若误判成 `make test`，每次自验证都会以 "No rule to make target" 失败。
    ['make 仅 test- 前缀目标', { Makefile: 'test-all:\n\techo t\n' }, undefined],
    ['make test 是变量赋值', { Makefile: 'test := 1\n' }, undefined],
    ['make test 是等号赋值', { Makefile: 'test = 1\n' }, undefined],
    ['make test 带依赖', { Makefile: 'test: build\n\techo t\n' }, 'make test'],
    ['空仓库', {}, undefined],
  ];

  for (const [label, files, expected] of cases) {
    const root = makeRepo(files);
    try {
      assert.strictEqual(SelfVerifyCommandDetector.detect(root), expected, label);
    } finally {
      dropRepo(root);
    }
  }
});

test('探测：目录不存在时返回 undefined（fail-closed，不抛错）', () => {
  assert.strictEqual(
    SelfVerifyCommandDetector.detect(join(tmpdir(), 'omni-not-exist-xyz')),
    undefined,
  );
  assert.strictEqual(SelfVerifyCommandDetector.detect('   '), undefined);
});

test('探测优先级：多生态并存时取表中的首个命中（npm > pytest > cargo > go）', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'Cargo.toml': '[package]\nname="x"\n',
    'go.mod': 'module x\n',
  });
  try {
    assert.strictEqual(SelfVerifyCommandDetector.detect(root), 'npm test');
  } finally {
    dropRepo(root);
  }

  const noNpm = makeRepo({
    'pytest.ini': '[pytest]\n',
    'Cargo.toml': '[package]\nname="x"\n',
  });
  try {
    assert.strictEqual(SelfVerifyCommandDetector.detect(noNpm), 'pytest -q');
  } finally {
    dropRepo(noNpm);
  }
});

test('forWorkspace：显式命令绕过「测试症状」闸门；无证据且无命令则不启用', () => {
  const bare = makeRepo({ 'README.md': 'x' });
  try {
    // ① 无证据、无显式命令 ⇒ 不启用（fail-closed）
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(bare), undefined);
    // ② 显式命令是最强证据 ⇒ 直接启用（原实现把它挡在闸门之外）
    assert.strictEqual(
      SelfVerifyPolicy.forWorkspace(bare, { command: 'make check' })?.command,
      'make check',
    );
    // ③ 显式命令优先于探测结果
    assert.strictEqual(
      SelfVerifyPolicy.forWorkspace(bare, { command: '  cargo nextest run  ' })?.command,
      'cargo nextest run',
    );
  } finally {
    dropRepo(bare);
  }

  const cargo = makeRepo({ 'Cargo.toml': '[package]\nname="x"\n' });
  try {
    assert.strictEqual(SelfVerifyPolicy.forWorkspace(cargo)?.command, 'cargo test');
    assert.strictEqual(
      SelfVerifyPolicy.forWorkspace(cargo, { command: 'cargo test --all-features' })?.command,
      'cargo test --all-features',
    );
    // 预算默认值保守（不进主门禁、可关、有上限）
    const policy = SelfVerifyPolicy.forWorkspace(cargo);
    assert.strictEqual(policy?.timeoutMs, SelfVerifyPolicy.DEFAULT_TIMEOUT_MS);
    assert.strictEqual(policy?.maxRunsPerSession, SelfVerifyPolicy.DEFAULT_MAX_RUNS_PER_SESSION);
    assert.strictEqual(policy?.cooldownMs, SelfVerifyPolicy.DEFAULT_COOLDOWN_MS);
  } finally {
    dropRepo(cargo);
  }
});

test('from：空白命令落回默认值；isVerifiableTarget 覆盖多语言源码扩展名', () => {
  assert.strictEqual(
    SelfVerifyPolicy.from({ command: '   ' }).command,
    SelfVerifyPolicy.DEFAULT_COMMAND,
  );
  assert.strictEqual(SelfVerifyPolicy.from().command, SelfVerifyPolicy.DEFAULT_COMMAND);

  for (const path of ['a.ts', 'a.py', 'a.rs', 'a.go', 'a.java', 'a.kt', 'a.cs', 'a.rb', 'a.cpp']) {
    assert.ok(SelfVerifyPolicy.isVerifiableTarget(path), `${path} 应属可验证目标`);
  }
  for (const path of ['README.md', 'data.json', 'noext']) {
    assert.ok(!SelfVerifyPolicy.isVerifiableTarget(path), `${path} 不应触发自验证`);
  }
});
