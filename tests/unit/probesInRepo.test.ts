/**
 * **入库探针**判据（G21，2026-10-03 第十九轮）。
 *
 * ## 背景
 *
 * 本仓此前的行为判据有 **26 个 `.mjs` 探针**躺在 gitignored 的 `.omniharness/` 里：GitHub 上不存在、
 * CI 不跑、别人复现不了——"判据"于是成了**只有作者本机才有**的东西。G21 把有价值的搬进
 * `tools/probes/`，本文件负责让"搬进来"这件事**不退化**：
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 每个探针都在 `tools/probes/README.md` 里登记（漏登记 = 别人不知道它存在，等于没入库） |
 * | ② | 每个探针都有「回答什么 / 口径 / 前置 / 诚实边界」四段头注释（口径事故大多源于缺这四段） |
 * | ③ | **可移植**：不得出现绝对路径、不得依赖 gitignored 的 `.omniharness/`（否则干净克隆跑不了） |
 * | ④ | **可复现**：缺编译产物时不静默失败，而是给出可执行提示并非零退出（`process.exit(2)`） |
 * | ⑤ | 支持 `--json=` 机器可读输出（便于对照与自动化） |
 * | ⑥ | **实跑自证**：最便宜的探针真的能跑通并给出结构正确的数字（不是"文件存在"就算数） |
 *
 * 判据⑥为什么必要：本仓已多次吃到"声明有 ≠ 路径上真的有"（pre-commit 的 prettier 曾长期被静默跳过）。
 * 探针的价值全在"能跑出数字"，所以判据必须**真的跑一次**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROBES_DIR = join(ROOT, 'tools', 'probes');

/** 本目录下的探针文件（`.mjs`，排除 README）。 */
function probeFiles(): string[] {
  return readdirSync(PROBES_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
}

test('① 每个探针都在 tools/probes/README.md 里登记', () => {
  const readme = readFileSync(join(PROBES_DIR, 'README.md'), 'utf8');
  const missing = probeFiles().filter((name) => !readme.includes(name));
  assert.deepStrictEqual(
    missing,
    [],
    `以下探针没在 README 登记（别人不知道它存在）：${missing.join('、')}`,
  );
  assert.ok(probeFiles().length >= 3, `探针数异常偏少（${String(probeFiles().length)}）`);
});

test('② 每个探针都有四段头注释（回答什么 / 口径 / 前置 / 诚实边界）', () => {
  for (const name of probeFiles()) {
    const text = readFileSync(join(PROBES_DIR, name), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node'), `${name} 缺 shebang`);
    for (const section of ['回答什么问题', '前置', '用法', '诚实边界']) {
      assert.ok(text.includes(section), `${name} 缺头注释段「${section}」`);
    }
  }
});

test('③ 可移植：无绝对路径、不依赖 gitignored 的 .omniharness/', () => {
  for (const name of probeFiles()) {
    const text = readFileSync(join(PROBES_DIR, name), 'utf8');
    // 绝对路径（Windows 盘符 / POSIX 用户目录）会让干净克隆直接跑不了。
    assert.ok(!/[A-Za-z]:[\\/]/.test(text), `${name} 含 Windows 绝对路径`);
    assert.ok(!text.includes('/home/'), `${name} 含 POSIX 绝对路径`);
    // `.omniharness/` 是 gitignored 的运行时目录：依赖它 = 干净克隆没这份数据。
    assert.ok(
      !/['"`][^'"`]*\.omniharness[^'"`]*['"`]/.test(text),
      `${name} 依赖 .omniharness/（gitignored ⇒ 干净克隆跑不了）`,
    );
  }
});

test('④ 缺编译产物时给出可执行提示并非零退出（不静默失败）', () => {
  for (const name of probeFiles()) {
    const text = readFileSync(join(PROBES_DIR, name), 'utf8');
    assert.ok(text.includes('npm run build'), `${name} 未提示先构建（npm run build）`);
    assert.ok(/process\.exit\(2\)/.test(text), `${name} 缺编译产物时未以退出码 2 终止`);
  }
});

test('⑤ 支持 --json= 机器可读输出', () => {
  for (const name of probeFiles()) {
    const text = readFileSync(join(PROBES_DIR, name), 'utf8');
    assert.ok(text.includes("arg('json'"), `${name} 未支持 --json=<path>`);
    assert.ok(text.includes('JSON.stringify'), `${name} 未序列化 JSON`);
  }
});

test('⑥ 实跑自证：工具暴露探针真能跑通并给出结构正确的数字', () => {
  // 选最便宜的探针（无需索引语料）。这是"能跑出数字"的端到端证明，而不是"文件存在"。
  const out = execFileSync(
    process.execPath,
    [
      join(PROBES_DIR, 'toolExposureBudget.mjs'),
      '--json=' + join(ROOT, '.omni-storage', 'probeSelfCheck.json'),
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.match(out, /工具总数 \d+/, '未打印工具总数');
  const report = JSON.parse(
    readFileSync(join(ROOT, '.omni-storage', 'probeSelfCheck.json'), 'utf8'),
  ) as {
    readonly probe: string;
    readonly totalTools: number;
    readonly planMode: {
      readonly rows: readonly { readonly visible: number }[];
      readonly avgVisible: number;
    };
  };
  assert.strictEqual(report.probe, 'toolExposureBudget');
  assert.ok(report.totalTools > 10, `工具总数异常：${String(report.totalTools)}`);
  assert.ok(report.planMode.rows.length >= 5, 'plan 模式应有多条任务样本');
  for (const row of report.planMode.rows) {
    assert.ok(row.visible >= 0 && row.visible <= report.totalTools, '可见工具数越界');
  }
  assert.ok(
    report.planMode.avgVisible <= report.totalTools,
    'plan 模式均值不应超过工具总数（否则"降级"没有发生）',
  );
});
