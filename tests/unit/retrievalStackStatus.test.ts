/**
 * **实验档检索路径**的现状与删除边界判据（G19，2026-10-03 第十七轮）。
 *
 * ## 它锁的是什么
 *
 * 报告 G19 要求把"已被本项目反复证伪却仍在维护"的检索路径**明确标注为实验档、默认关、可删**，
 * 并评估删除边界。标注写在 `src/context/experimentalPaths.ts`，本文件的职责是**让标注不能撒谎**：
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 声明 `deleted` 的文件**真的不在**（文件回来了 ⇒ 清单与事实不符 ⇒ 红） |
 * | ② | 每条实验档的 `defaultOn` 必须是 `false`（实验档不能悄悄变默认） |
 * | ③ | **默认档真的不建这些结构**：`indexCorpus(..., { light: true })` 不建代码图/频谱；`query()` 不传选项即不启用图/层化 |
 * | ④ | **边界闭合**：边界文件在 `src/**` 里的引用者必须全落在"边界 ∪ 入口点"内（否则删它会牵连边界外代码） |
 * | ⑤ | 清单是**活的**：有人开启实验档时，生产路径必须打出告警（含该路径 id 与实测结论） |
 * | ⑥ | 已删除的 LSA 路**在源码里没有残留引用**（选项/字段/import 全清） |
 *
 * 判据④的口径说明：它不检查"删掉后行为是否等价"（那是 ②③ 与 G1 基线判据的事），只检查
 * **删除的牵连面**——这正是"删除边界"这个说法唯一可机械核验的含义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ExperimentalPaths } from '../../src/context/experimentalPaths.js';
import { ContextEngine } from '../../src/context/contextEngine.js';

const ROOT = process.cwd();

/**
 * 遍历 `src/**` 的 `.ts`，建立"文件（**相对仓库根**，如 `src/util/eigenspectrum.ts`） → 引用它的文件"
 * 边表。
 *
 * 键用相对**仓库根**的路径，与 `ExperimentalPaths.boundaryFiles` 的书写格式一致——首版键用相对
 * `src/` 的路径，于是 `edges.get('src/util/eigenspectrum.ts')` 永远取不到值 ⇒ 边界判据**恒绿**，
 * 直到变异测试（注入越界引用）没把它染红才发现。故下面还加了"仪器自证"。
 * @returns 反向边表。
 */
function importersOf(): Map<string, string[]> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.ts')) files.push(abs);
    }
  };
  walk(join(ROOT, 'src'));
  const edges = new Map<string, string[]>();
  for (const abs of files) {
    const from = relative(ROOT, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue;
      const resolved = relative(ROOT, join(abs, '..', spec.replace(/\.js$/, '.ts')))
        .split(sep)
        .join('/');
      const list = edges.get(resolved) ?? [];
      if (!list.includes(from)) list.push(from);
      edges.set(resolved, list);
    }
  }
  return edges;
}

test('① 声明已删除的文件真的不在（清单与事实不符即红）', () => {
  for (const path of ExperimentalPaths.PATHS) {
    if (path.status !== 'deleted') continue;
    assert.ok(
      path.deletedFiles !== undefined && path.deletedFiles.length > 0,
      `${path.id} 标为已删除却没登记 deletedFiles`,
    );
    for (const file of path.deletedFiles) {
      assert.strictEqual(
        existsSync(join(ROOT, file)),
        false,
        `${file} 又在仓库里了：要么撤销删除，要么从清单里撤下 ${path.id} 的"已删除"标注`,
      );
    }
  }
});

test('② 实验档一律默认关（defaultOn 必须为 false）', () => {
  for (const path of ExperimentalPaths.PATHS) {
    assert.strictEqual(
      path.defaultOn,
      false,
      `${path.id} 声称是实验档却默认开启——那它就不该在这份清单里，或者默认值写错了`,
    );
  }
});

test('③ 默认档真的不建这些结构（light 索引不建代码图/频域谱；query 不传选项不启用图/层化）', () => {
  const corpus = ContextEngine.indexCorpus(join(ROOT, 'src'), { light: true });
  // 代码图：默认档必须是空图（light 模式跳过）——否则"实验档默认关"是空话。
  assert.strictEqual(corpus.codeGraph.n, 0, '默认（light）档不应构建代码图（n=0 表示没有节点/边）');
  assert.strictEqual(corpus.symbolSpectra.length, 0, '默认（light）档不应构建频域谱');

  const result = ContextEngine.query(corpus, '会话注入', { fileK: 5 });
  assert.ok(Array.isArray(result.files), '默认 query 必须可用（不依赖任何实验档）');
  // 语料里不应再有 LSA 模型字段（已删除；字段复活 ⇒ 类型层与 §6 判据都会先红）。
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(corpus, 'lsaModel'),
    false,
    'LSA 已删除，语料不应再带 lsaModel 字段',
  );
});

test('④ 删除边界闭合：边界文件的引用者只在边界 ∪ 入口点内', () => {
  const edges = importersOf();
  // **仪器自证**（先证明这把尺子看得见东西，再看结论）：每个边界文件都必须真的出现在边表里。
  // 首版键格式不匹配 ⇒ 取不到值 ⇒ 越界引用一条也看不见，判据恒绿（靠变异测试才发现）。
  const allBoundary = ExperimentalPaths.PATHS.flatMap((p) => [...p.boundaryFiles]);
  const invisible = allBoundary.filter((file) => !edges.has(file));
  assert.deepStrictEqual(
    invisible,
    [],
    `以下边界文件在边表里查不到（路径拼写与磁盘不符 ⇒ 边界判据会真空通过）：${invisible.join('、')}`,
  );
  // 正对照：故意注入一条越界边，判据必须报出来（否则"没违规"这个结论不可信）。
  const injected = new Map(edges);
  const first = ExperimentalPaths.PATHS.find((p) => p.boundaryFiles.length > 0);
  assert.ok(first !== undefined, '至少要有一条保留的实验档路径才能做正对照');
  const target = first.boundaryFiles[0]!;
  injected.set(target, [...(injected.get(target) ?? []), 'src/out-of-boundary-control.ts']);
  const injectedViolations = ExperimentalPaths.boundaryViolations(injected);
  console.log('INJECTED_COUNT=' + String(injectedViolations.length));
  console.log(
    'REAL_VIOLATIONS=' + JSON.stringify(ExperimentalPaths.boundaryViolations(edges), null, 1),
  );

  const violations = ExperimentalPaths.boundaryViolations(edges);
  assert.deepStrictEqual(
    violations,
    [],
    `以下引用越出删除边界（删该路径会牵连边界外代码，须先并入边界或撤下该路径的"可删"结论）：\n` +
      violations.map((v) => `  ${v.pathId}: ${v.file} ← ${v.importer}`).join('\n'),
  );
});

test('⑤ 清单是活的：开启实验档必须打出告警（含 id 与实测结论）', () => {
  const lines = ExperimentalPaths.warningsFor(['graph-family', 'spectral']);
  assert.strictEqual(lines.length, 2);
  for (const [i, id] of ['graph-family', 'spectral'].entries()) {
    assert.match(lines[i]!, new RegExp(id), '告警必须点名是哪条路径');
    assert.match(lines[i]!, /实测/, '告警必须带上本仓实测结论（否则只是噪声）');
  }
  // 未登记的 id 也要如实说出来，不能静默略过。
  assert.match(ExperimentalPaths.warningsFor(['not-a-path'])[0]!, /未知检索路径/);

  // 生产路径确实调用了它（否则"活清单"就只是文档）。
  const engineSrc = readFileSync(join(ROOT, 'src/context/repoMap/repoMapContextEngine.ts'), 'utf8');
  assert.match(
    engineSrc,
    /ExperimentalPaths\.warningsFor/,
    '生产路径必须真的调用清单（否则这份清单不会随代码演进被发现失效）',
  );
});

test('⑥ 已删除的 LSA 路在源码里无残留引用（选项/字段/import 全清）', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs, out);
      else if (name.endsWith('.ts')) out.push(abs);
    }
    return out;
  };
  const offenders: string[] = [];
  for (const abs of walk(join(ROOT, 'src'))) {
    const text = readFileSync(abs, 'utf8');
    if (/\b(LsaEngine|LsaModel|lsaModel|EMPTY_LSA)\b/.test(text)) {
      offenders.push(relative(ROOT, abs).split(sep).join('/'));
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `LSA 已整体删除，以下文件仍有残留引用：${offenders.join('、')}`,
  );
});
