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
 * | ⑧ | **旗标不许静默失效**：未知旗标 / 值旗标的空格形式一律**退出码 2**（2026-10-06：`arg()` 被打坏成 `startsWith()` ⇒ `--chunks/--rerank/--json` 全部静默失效，两次"变体实测"跑的是默认配置） |
 * | ⑨ | **文档↔代码交叉核对**：探针 `## 用法` 命令里写的每个旗标，都必须是它 `--list-knobs` 真的认识的旋钮（反之亦然）——防"文档写了、代码不认"的漂移 |
 *
 * 判据⑥为什么必要：本仓已多次吃到"声明有 ≠ 路径上真的有"（pre-commit 的 prettier 曾长期被静默跳过）。
 * 探针的价值全在"能跑出数字"，所以判据必须**真的跑一次**。判据⑧⑨是同一纪律的延伸：**仪器必须
 * 回显/校验自己的生效配置**，否则"旗标没生效"与"旋钮无效果"不可区分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROBES_DIR = join(ROOT, 'tools', 'probes');

/**
 * 本目录下的探针文件（`.mjs`，排除 README 与 `_` 前缀的**共享模块**）。
 *
 * `_args.mjs` 是探针共用的严格命令行解析器（**不是**探针：它不产出任何数字、也没有四段头注释），
 * 故不参与"探针登记/头注释/免网络"这几条判据；它自身的语义由判据⑧实跑钉住。
 * @returns 探针文件名数组（已排序，保证判据确定性）。
 */
function probeFiles(): string[] {
  return readdirSync(PROBES_DIR)
    .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
    .sort();
}

/**
 * 实跑一个探针（captures stdout/stderr）。
 * @param name 探针文件名。
 * @param args 命令行参数。
 * @returns 退出码与输出（stdout/stderr 合并便于断言）。
 */
function runProbe(
  name: string,
  args: readonly string[],
): { readonly status: number | null; readonly out: string } {
  const r = spawnSync(process.execPath, [join(PROBES_DIR, name), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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
    // 盘符 = 「前面**不是字母**的单字母 + 冒号 + 斜杠」：URL scheme（如 https://）里的
    // 「s:/」前面有字母，不属盘符——2026-10-05 语义探针的注释 URL 误触过本正则（假阳性）。
    assert.ok(!/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(text), `${name} 含 Windows 绝对路径`);
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
    // 行为化（2026-10-06）：从"源码里有 `arg('json'`"改为"**实跑** --list-knobs 必须列出 json"——
    // 前者会在解析器被重构/打坏时给出假绿（正是本轮踩过的形态）。
    const knobs = JSON.parse(runProbe(name, ['--list-knobs']).out.trim()) as string[];
    assert.ok(knobs.includes('json'), `${name} 未支持 --json=<path>（--list-knobs 未列出 json）`);
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

test('⑧ 旗标不许静默失效：未知旗标与"值旗标的空格形式"都必须退出码 2', () => {
  // 正对照必须先立住：**合法写法**要能被接受（否则"全都拒绝"也能骗过下面的断言）。
  const ok = runProbe('recallHitrate.mjs', ['--fileK=14', '--rerank=1', '--list-knobs']);
  assert.strictEqual(ok.status, 0, `合法旗标被拒：${ok.out}`);
  assert.match(ok.out, /"fileK"/, '--list-knobs 应列出认识的值旗标');
  // 负对照 1：未知旗标（拼错的名字）不得被静默忽略。
  const unknown = runProbe('recallHitrate.mjs', ['--nonexistent-flag=1', '--list-knobs']);
  assert.strictEqual(unknown.status, 2, `未知旗标未被拒绝：${unknown.out}`);
  assert.match(unknown.out, /未知旗标/, '未知旗标应给出可读原因');
  // 负对照 2：值旗标的**空格形式**（`--fileK 14`）必须被拒绝而不是静默取默认值——
  // 这正是 `--pool 400` 那类"文档这么写、实现只认等号"的缺陷形态。
  const spaceForm = runProbe('recallHitrate.mjs', ['--fileK', '14', '--list-knobs']);
  assert.strictEqual(spaceForm.status, 2, `空格形式未被拒绝：${spaceForm.out}`);
  assert.match(spaceForm.out, /静默失效/, '拒绝理由要点明"空格形式会静默失效"');
  // 负对照 3：位置参数越界（历史缺陷：`Number(process.argv[2])` 遇旗标变 NaN ⇒ 打印全 0% 报表、退出码 0）。
  // 注意**不能**带 `--list-knobs`：那个保留旗标会在扫描到位置参数之前就正常退出。
  const extra = runProbe('bm25TuneSweep.mjs', ['stray-positional']);
  assert.strictEqual(extra.status, 2, `多余位置参数未被拒绝：${extra.out}`);
  assert.match(extra.out, /位置参数/, '拒绝理由应点明"位置参数"');
});

test('⑨ 用法块里的旗标 == 探针真正认识的旋钮（文档↔代码交叉核对）', () => {
  for (const name of probeFiles()) {
    const text = readFileSync(join(PROBES_DIR, name), 'utf8');
    // 取 `## 用法` 到下一个 `* ## ` 之间的段落，只看其中**真的敲得出去的命令行**（以 node tools/probes/ 开头的行）。
    const usageStart = text.indexOf('## 用法');
    assert.ok(usageStart >= 0, `${name} 缺「## 用法」段`);
    const nextSection = text.indexOf('* ## ', usageStart + 1);
    const usage = text.slice(usageStart, nextSection < 0 ? text.length : nextSection);
    const commandLines = usage
      .split('\n')
      .filter((line) => line.includes('node tools/probes/'))
      .join('\n');
    const docFlags = new Set(
      // 旗标名**大小写敏感**（`--fileK`、`--json` 都合法）：正则必须允许大写，否则 `--fileK=14`
      // 会被截成 `--file`，判据自己产生假阳性（首版就这么错过了）。
      [...commandLines.matchAll(/--[a-zA-Z][a-zA-Z0-9-]*/g)].map((m) => m[0] as string),
    );
    // 代码侧：`--list-knobs` 由共享解析器在**任何 import 之前**应答 ⇒ 便宜且不需要编译产物。
    const knobs = runProbe(name, ['--list-knobs']);
    assert.strictEqual(knobs.status, 0, `${name} --list-knobs 失败：${knobs.out}`);
    const declared = JSON.parse(knobs.out.trim()) as string[];
    const declaredFlags = new Set(declared.map((k) => `--${k}`));
    const documentedButUnknown = [...docFlags].filter((f) => !declaredFlags.has(f));
    assert.deepStrictEqual(
      documentedButUnknown,
      [],
      `${name} 的用法块宣传了它并不认识的旗标（照文档敲下去会静默失效或报错）：${documentedButUnknown.join(', ')}`,
    );
    for (const knob of declared) {
      assert.ok(
        usage.includes(knob),
        `${name} 认识的旋钮 ${knob} 没在用法块登记（只读头注释的人会以为它不存在）`,
      );
    }
  }
});

test('⑦ G21-b：schema token 预算取自**真实 schema**且节省量自洽', () => {
  // 复跑探针（同上），只看新增的 schema 段：它必须来自生产装配入口的真实工具定义，
  // 而不是人工构造的假 schema（否则"省了多少 token"没有意义）。
  const out = execFileSync(
    process.execPath,
    [
      join(PROBES_DIR, 'toolExposureBudget.mjs'),
      '--json=' + join(ROOT, '.omni-storage', 'probeSchemaCheck.json'),
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(out, /schema token 预算/, '未打印 schema 预算段');
  const report = JSON.parse(
    readFileSync(join(ROOT, '.omni-storage', 'probeSchemaCheck.json'), 'utf8'),
  ) as {
    readonly schemaBudget: {
      readonly caliber: string;
      readonly registeredTools: number;
      readonly offSchemaTokens: number;
      readonly rows: readonly {
        readonly visible: number;
        readonly total: number;
        readonly visibleSchemaTokens: number;
        readonly savedTokens: number;
        readonly savedRatio: number;
      }[];
    };
  };
  const budget = report.schemaBudget;
  assert.ok(budget.registeredTools >= 25, `注册工具数异常：${String(budget.registeredTools)}`);
  assert.ok(budget.offSchemaTokens > 0, 'off 模式 schema token 必须为正（含真实 schema）');
  assert.match(budget.caliber, /默认配置/, '口径必须写明 schema 来自默认配置的真实注册表');
  assert.ok(budget.rows.length >= 5, 'schema 预算应有多条任务样本');
  for (const row of budget.rows) {
    assert.ok(row.visible <= row.total, '可见工具数不应超过注册数');
    assert.ok(row.visibleSchemaTokens <= budget.offSchemaTokens, '可见子集 token 不应超过全部');
    assert.strictEqual(
      row.savedTokens,
      budget.offSchemaTokens - row.visibleSchemaTokens,
      '节省量必须等于"全部 − 可见子集"（自洽性）',
    );
    assert.ok(row.savedRatio >= 0 && row.savedRatio <= 1, '节省比例越界');
  }
  // **fail-safe 可见**：至少有一条（不命中类别的）任务节省为 0 —— 这是刻意的保守设计，必须留着。
  assert.ok(
    budget.rows.some((row) => row.savedTokens === 0),
    '未命中类别的任务应全放行（节省 0）：这条 fail-safe 行为不能被"优化"掉',
  );
});
