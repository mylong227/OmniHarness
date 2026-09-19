/**
 * TaskEnvironmentReader 契约单测（容器无关的环境声明）。
 *
 * 与 `terminalBench.test.ts` 的分工：本文件只测「环境声明怎么读」——
 * `env.json` 的解析容错、标准清单回落、显式声明优先级；不涉及解析 task.yaml、
 * 起后端或跑判分（那些在另外两份文件里）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskEnvironmentReader } from '../../src/benchmark/terminalbench/taskEnvironmentReader.js';

test('TaskEnvironmentReader：env.json 全字段解析（含字符串简写与数字版本）', () => {
  const spec = TaskEnvironmentReader.parse(
    JSON.stringify({
      python: 3.13,
      pip: ['-e', '.[dev]', 'pandas==2.3.0'],
      apt: ['curl', 'sqlite3'],
      shell: ['unzip data.zip'],
      seeds: ['seed.txt', { from: 'task-deps/data.csv', to: 'data' }],
    }),
  );
  assert.strictEqual(spec.pythonVersion, '3.13', '数字写法与字符串等价');
  assert.deepStrictEqual([...spec.pipArgs!], ['-e', '.[dev]', 'pandas==2.3.0'], '旗标也要原样保留');
  assert.deepStrictEqual([...spec.aptPackages!], ['curl', 'sqlite3']);
  assert.deepStrictEqual([...spec.shellCommands!], ['unzip data.zip']);
  assert.deepStrictEqual(
    [...spec.seeds!],
    [
      { from: 'seed.txt', to: '.' },
      { from: 'task-deps/data.csv', to: 'data' },
    ],
    '字符串简写等价于落到应用根',
  );
  assert.deepStrictEqual([...spec.warnings], []);
});

test('TaskEnvironmentReader：坏字段只忽略该条并告警，绝不整题作废', () => {
  const spec = TaskEnvironmentReader.parse(
    JSON.stringify({ python: 'python-3.11', pip: ['numpy', 7], pips: ['typo'], seeds: [{}] }),
  );
  assert.strictEqual(spec.pythonVersion, '3.11', '带前缀的写法归一成主次版本');
  assert.deepStrictEqual([...spec.pipArgs!], ['numpy'], '非字符串项被剔掉，其余照常生效');
  assert.strictEqual(spec.seeds!.length, 0, '缺 from 的种子条目被忽略');
  assert.strictEqual(
    spec.warnings.length,
    3,
    `应分别告警：pip 非法项 / 未知字段 / 缺 from；实际 ${spec.warnings.join('；')}`,
  );
  assert.ok(
    spec.warnings.some((w) => w.includes('pips')),
    '未知字段必须告警（拼错字段会伪装成环境缺依赖）',
  );
});

test('TaskEnvironmentReader：`null` 视为「未声明」，不产生告警', () => {
  const spec = TaskEnvironmentReader.parse(
    JSON.stringify({ python: null, pip: null, seeds: null }),
  );
  assert.strictEqual(spec.pythonVersion, undefined);
  assert.strictEqual(spec.pipArgs, undefined);
  assert.strictEqual(spec.seeds, undefined);
  assert.deepStrictEqual([...spec.warnings], [], 'null 是「交调用方决定」的自然写法，不该告警');
});

test('TaskEnvironmentReader：env.json 非法 JSON 时整份忽略并回落标准清单', () => {
  const spec = TaskEnvironmentReader.parse('{ this is not json');
  assert.strictEqual(spec.pythonVersion, undefined);
  assert.strictEqual(spec.pipArgs, undefined);
  assert.match(spec.warnings[0] ?? '', /不是合法 JSON/);
});

test('TaskEnvironmentReader：无 env.json 时按容器无关的标准清单推断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbench-env-'));
  writeFileSync(join(dir, '.python-version'), '3.12.4\n');
  writeFileSync(join(dir, 'requirements.txt'), 'pandas==2.3.0\n');
  writeFileSync(join(dir, 'apt.txt'), '# 注释\ncurl\nsqlite3\n');
  const env = TaskEnvironmentReader.read(dir);
  assert.strictEqual(env.source, 'manifests');
  assert.strictEqual(env.pythonVersion, '3.12');
  assert.deepStrictEqual([...env.pipArgs], ['-r', 'requirements.txt']);
  assert.deepStrictEqual([...env.aptPackages], ['curl', 'sqlite3']);
  assert.deepStrictEqual([...env.seeds], [], '标准清单不表达落点 ⇒ 空 = 整目录兜底拷贝');
  assert.ok(
    env.warnings.some((w) => w.includes('.python-version')) &&
      env.warnings.some((w) => w.includes('requirements.txt')),
    '推断出来的取值必须写进告警（推断 ≠ 任务声明）',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('TaskEnvironmentReader：pyproject.toml 推断出 requires-python 与可编辑安装', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbench-env-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    ['[project]', 'name = "task"', 'requires-python = ">=3.11"', ''].join('\n'),
  );
  const env = TaskEnvironmentReader.read(dir);
  assert.strictEqual(env.pythonVersion, '3.11');
  assert.deepStrictEqual([...env.pipArgs], ['-e', '.']);
  rmSync(dir, { recursive: true, force: true });
});

test('TaskEnvironmentReader：什么都没有时回 none，且不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbench-env-'));
  const env = TaskEnvironmentReader.read(dir);
  assert.strictEqual(env.source, 'none');
  assert.strictEqual(env.pythonVersion, null);
  assert.deepStrictEqual([...env.pipArgs], []);
  assert.deepStrictEqual([...env.warnings], []);
  rmSync(dir, { recursive: true, force: true });
});

test('TaskEnvironmentReader：env.json 已声明的字段优先于标准清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tbench-env-'));
  writeFileSync(join(dir, '.python-version'), '3.12\n');
  writeFileSync(join(dir, 'requirements.txt'), 'pandas==2.3.0\n');
  writeFileSync(join(dir, 'env.json'), JSON.stringify({ python: '3.13', pip: ['numpy==2.1.2'] }));
  const env = TaskEnvironmentReader.read(dir);
  assert.strictEqual(env.source, 'env.json');
  assert.strictEqual(env.pythonVersion, '3.13', '显式声明覆盖推断值');
  assert.deepStrictEqual([...env.pipArgs], ['numpy==2.1.2'], '显式 pip 覆盖 -r 推断');
  rmSync(dir, { recursive: true, force: true });
});
