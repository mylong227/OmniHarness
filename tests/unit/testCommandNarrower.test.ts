/**
 * 定向测试收窄单测：把「定向只覆盖 npm」这条缺口钉死。
 *
 * 两条不变量：
 * ① **只接受测试文件**——堆栈帧多数指向被测源码，`src/core/foo.ts` 被透传给运行器会
 *    判成「没有匹配的测试」而**假失败**；不做定向 ＞ 假定向。
 * ② **只对文档化的收窄参数拼接**（npm `--` / pytest 位置参数 / `cargo --test` /
 *    `mvn -Dtest` / `gradle --tests` / `go test <目录>` / `dotnet --filter`），
 *    认不出的命令原样返回（退回全量），**不做瞎猜**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestCommandNarrower } from '../../src/adapters/tool/verify/testCommandNarrower.js';

/**
 * 收窄的简写。
 *
 * @param command 测试命令。
 * @param files 失败输出里解析到的文件。
 * @returns 收窄后的命令。
 */
const narrow = (command: string, files: readonly string[]): string =>
  TestCommandNarrower.narrow(command, files);

test('isTestPath：只认命名约定，不认「在 tests 目录里就是测试」', () => {
  const expectTrue = [
    'src/a.test.ts',
    'src/a.spec.tsx',
    'tests/unit/foo.test.ts',
    'test_x.py',
    'x_test.py',
    'pkg/foo_test.go',
    'src/test/java/com/x/FooTest.java',
    'src/test/java/com/x/FooIT.java',
    'FooTests.cs',
    'tests/it.rs',
    'spec/a_spec.rb',
  ];
  const expectFalse = [
    // 被测源码（堆栈帧最常见形态）——透传会「没有匹配的测试」假失败
    'src/core/foo.ts',
    'shared/pkg/a.go',
    // tests 目录里的助手/夹具不是测试单元
    'tests/unit/fixtures.ts',
    'tests/helpers/tempWorkspace.ts',
    'Cargo.toml',
    'README.md',
  ];

  for (const file of expectTrue) {
    assert.ok(TestCommandNarrower.isTestPath(file), `${file} 应被认作测试文件`);
  }
  for (const file of expectFalse) {
    assert.ok(!TestCommandNarrower.isTestPath(file), `${file} 不应被认作测试文件`);
  }
});

test('收窄：各运行器用各自文档化的参数', () => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ['npm test', ['tests/unit/a.test.ts'], 'npm test -- tests/unit/a.test.ts'],
    ['npm run test', ['a.test.ts', 'b.spec.tsx'], 'npm run test -- a.test.ts b.spec.tsx'],
    ['pnpm test', ['a.test.ts'], 'pnpm test -- a.test.ts'],
    ['yarn test', ['a.test.ts'], 'yarn test -- a.test.ts'],
    ['pytest -q', ['tests/test_a.py'], 'pytest -q tests/test_a.py'],
    ['python -m pytest', ['test_a.py'], 'python -m pytest test_a.py'],
    ['jest', ['src/a.test.ts'], 'jest src/a.test.ts'],
    ['npx vitest run', ['src/a.test.ts'], 'npx vitest run src/a.test.ts'],
    ['bundle exec rspec', ['spec/a_spec.rb'], 'bundle exec rspec spec/a_spec.rb'],
    ['go test ./...', ['pkg/a_test.go'], 'go test ./pkg'],
    ['go test -count=1 ./...', ['pkg/a_test.go'], 'go test -count=1 ./pkg'],
    ['cargo test', ['tests/foo.rs'], 'cargo test --test foo'],
    ['mvn -q test', ['src/test/java/com/x/FooTest.java'], 'mvn -q test -Dtest=FooTest'],
    ['gradle test', ['src/test/java/com/x/FooTest.java'], 'gradle test --tests com.x.FooTest'],
    ['dotnet test', ['tests/FooTests.cs'], 'dotnet test --filter "FullyQualifiedName~FooTests"'],
  ];

  for (const [command, files, expected] of cases) {
    assert.strictEqual(narrow(command, files), expected, `${command} ← ${files.join(',')}`);
  }
});

test('收窄的保守边界：认不出/不适用一律原样返回（宁可全量，不要跑不起来的命令）', () => {
  // 非测试文件 ⇒ 不改写
  assert.strictEqual(narrow('npm test', ['src/core/foo.ts']), 'npm test');
  // 空清单 ⇒ 不改写
  assert.strictEqual(narrow('pytest -q', []), 'pytest -q');
  // 不认识的命令形态 ⇒ 不做猜测性拼接
  assert.strictEqual(narrow('make check', ['tests/test_a.py']), 'make check');
  assert.strictEqual(narrow('./ci/run.sh', ['tests/test_a.py']), './ci/run.sh');
  // go 的绝对路径无法转成包路径 ⇒ 退回全量
  assert.strictEqual(narrow('go test ./...', ['/abs/pkg/a_test.go']), 'go test ./...');
  // cargo 只认顶层 tests/<name>.rs；源码文件不适用 ⇒ 退回全量
  assert.strictEqual(narrow('cargo test', ['src/lib.rs']), 'cargo test');
  // maven/gradle 需要 src/test/java/ 标记，缺标记则无法推出全限定名 ⇒ 退回全量
  assert.strictEqual(narrow('mvn -q test', ['weird/FooTest.java']), 'mvn -q test');
});

test('收窄：源码与测试混合时只取测试文件，并去重、封顶 8 个目标', () => {
  assert.strictEqual(
    narrow('npm test', ['src/core/foo.ts', 'tests/unit/foo.test.ts', 'src/bar.ts']),
    'npm test -- tests/unit/foo.test.ts',
  );

  // go 的多文件同包 ⇒ 目录去重
  assert.strictEqual(narrow('go test ./...', ['pkg/a_test.go', 'pkg/b_test.go']), 'go test ./pkg');

  const many = Array.from({ length: 20 }, (_unused, index) => `tests/f${index}.test.ts`);
  const narrowed = narrow('npm test', many);
  assert.strictEqual(
    narrowed.split('--')[1]?.trim().split(' ').length,
    TestCommandNarrower.MAX_TARGETS,
  );
});
