/**
 * 受种技能池（`skills`）的**配置通道**接线单测：配置文件内联数组 + `--skills <file.json>`。
 *
 * 事故口径（TASK_BOARD §15.4 登记的功能缺口）：`OmniHarnessConfig.skills` 一直只有**编程入口**，
 * 配置文件与 CLI 都写不进去 ⇒ CLI 用户无法受种任何技能。本文件逐段钉住补齐后的链路：
 *   ① 配置文件内联 `skills` → `normalizeConfig` 校验通过 → `configDefaults` 映射进 CLI 参数；
 *   ② `--skills <file.json>`（可重复）→ 与内联合并（**同名以旗标为准**，因为注册表对重名直接抛错）；
 *   ③ 校验 fail-closed：非数组 / 缺字段 / 空字段 / 同源重名 / tags 类型错 / 文件缺失 / JSON 非法
 *      一律给出**带来源与下标**的可执行报错，绝不半途放行；
 *   ④ 端到端：经 `ConfigFactory.build` 后技能真进了 `skillRegistry`（不是只躺在配置里）。
 *
 * 另含一处同批修掉的配置校验缺陷回归：`approval: 'plan'` 曾被校验白名单拒绝（声明支持、校验拒绝）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '../../src/config/configError.js';
import type { FileConfig } from '../../src/config/configFile.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { Agent } from '../../src/core/agent.js';
import { ArgParser, CliDefaults } from '../../src/cli/argParser.js';
import { CliSkillFlags } from '../../src/cli/cliSkillFlags.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 一条合法技能。 */
const SKILL = {
  name: 'sql-review',
  description: '审查 SQL 迁移',
  instructions: '先看索引，再看锁表风险，最后给回滚方案。',
  tags: ['数据库', '审查'],
};

/** 在临时目录里写一个 JSON 文件并返回路径。 */
function writeJson(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

/** 建一个临时工作区（供 ConfigFactory.build 用）。 */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'omni-skills-'));
}

test('配置文件：内联 skills 通过校验并映射进 CLI 参数（tags 保留、空白被裁剪）', () => {
  const file = ConfigError.normalizeConfig({
    skills: [{ name: ' a ', description: ' b ', instructions: ' c ', tags: ['  t  ', ''] }],
  });
  assert.deepStrictEqual(file.skills, [
    { name: 'a', description: 'b', instructions: 'c', tags: ['t'] },
  ]);

  const mapped = ArgParser.configDefaults({ skills: file.skills } as FileConfig);
  assert.deepStrictEqual(
    mapped.skills,
    file.skills,
    'configDefaults 必须透传 skills（否则文件写入被静默丢弃）',
  );
  assert.strictEqual(mapped.skillsFile, undefined, '文件通道不产生 --skills 旗标值');
});

test('配置文件：未声明 skills 时不写该键（零行为变更）', () => {
  assert.strictEqual(ArgParser.configDefaults({} as FileConfig).skills, undefined);
  assert.strictEqual(ConfigError.normalizeConfig({ maxSteps: 3 }).skills, undefined);
});

test('--skills 旗标：解析为文件路径数组（可重复），且值不被当成 prompt', () => {
  const args = ArgParser.parseArgs(
    ['--skills', 'a.json', '--skills', 'b.json', '修个 bug'],
    CliDefaults,
  );
  assert.ok(args !== undefined, 'parseArgs 应给出参数（未落在用法错误分支）');
  assert.deepStrictEqual(args.skillsFile, ['a.json', 'b.json']);
  assert.strictEqual(args.prompt, '修个 bug', '旗标取值不得被吞成位置参数 prompt');
});

test('合并语义：配置文件内联 + 旗标文件，同名以旗标为准（注册表重名会抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-skills-flag-'));
  try {
    const path = writeJson(dir, 'skills.json', {
      skills: [
        { name: 'sql-review', description: '来自旗标', instructions: '旗标版本' },
        { name: 'perf', description: '性能', instructions: '先量后调。' },
      ],
    });
    const merged = CliSkillFlags.resolve({
      skills: [SKILL],
      skillsFile: [path],
    });
    assert.deepStrictEqual(
      merged.map((s) => s.name),
      ['sql-review', 'perf'],
    );
    assert.strictEqual(merged[0]?.description, '来自旗标', '同名以旗标为准');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旗标文件：接受裸数组与 { skills: [...] } 两种形态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-skills-shape-'));
  try {
    const bare = writeJson(dir, 'bare.json', [SKILL]);
    const wrapped = writeJson(dir, 'wrapped.json', { skills: [SKILL] });
    assert.strictEqual(CliSkillFlags.resolve({ skillsFile: [bare] }).length, 1);
    assert.strictEqual(CliSkillFlags.resolve({ skillsFile: [wrapped] }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验 fail-closed：结构/字段/重名/tags 各自给出带来源与下标的报错', () => {
  const cases: readonly { readonly raw: unknown; readonly match: RegExp }[] = [
    { raw: { skills: 'nope' }, match: /skills 必须是数组/ },
    { raw: { skills: [null] }, match: /skills\[0\] 必须是对象/ },
    {
      raw: { skills: [{ description: 'd', instructions: 'i' }] },
      match: /skills\[0\]\.name 必须是非空字符串/,
    },
    { raw: { skills: [{ name: 'a', instructions: 'i' }] }, match: /skills\[0\]\.description/ },
    {
      raw: { skills: [{ name: 'a', description: 'd', instructions: '   ' }] },
      match: /skills\[0\]\.instructions/,
    },
    { raw: { skills: [{ ...SKILL, tags: 'x' }] }, match: /skills\[0\]\.tags 必须是字符串数组/ },
    { raw: { skills: [SKILL, SKILL] }, match: /技能重名 "sql-review"/ },
  ];
  for (const { raw, match } of cases) {
    assert.throws(
      () => ConfigError.normalizeConfig(raw as Record<string, unknown>),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError, `应为 ConfigError，实际 ${String(error)}`);
        assert.match(error.message, match);
        return true;
      },
    );
  }
});

test('校验 fail-closed：文件缺失 / JSON 非法 → 报错带 --skills 路径与原因', () => {
  assert.throws(
    () => CliSkillFlags.resolve({ skillsFile: [join(tmpdir(), 'no-such-skills.json')] }),
    /--skills .*no-such-skills\.json: 无法读取技能包文件/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'omni-skills-bad-'));
  try {
    const broken = writeJson(dir, 'broken.json', '{ not json');
    assert.throws(
      () => CliSkillFlags.resolve({ skillsFile: [broken] }),
      /--skills .*broken\.json: JSON 解析失败/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：经 ConfigFactory.build 后技能真进 skillRegistry（不是只躺在配置里）', () => {
  const config = ConfigFactory.build({
    workspaceRoot: workspace(),
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [SKILL],
  });
  const names = config.skillRegistry.list().map((skill) => skill.name);
  assert.deepStrictEqual(
    names,
    ['sql-review'],
    '受种技能必须进入注册表（装配层真的消费了 skills）',
  );
  // 字面通道保留为精确通道（语义未变），相关性通道是生产注入判据。
  assert.strictEqual(config.skillRegistry.match('请帮我 sql-review 一下').length, 1);
  assert.strictEqual(config.skillRegistry.match('这段数据库迁移有问题').length, 1);
  assert.strictEqual(config.skillRegistry.selectForPrompt('请帮我 sql-review 一下').length, 1);
});

test('配置校验缺陷回归：approval: "plan" 必须被文件校验接受（声明支持、校验曾拒绝）', () => {
  assert.strictEqual(ConfigError.normalizeConfig({ approval: 'plan' }).approval, 'plan');
});

test('端到端（真 Agent）：命中技能时把 instructions 渲染为 system 事件注入会话', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: workspace(),
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [SKILL],
  });
  // 刻意**不传**第二参：验证「缺省取运行时组合根那一份」的兜底真的生效
  // （此前 11 个 new Agent(runtime) 调用点里只有 1 个传了技能注册表 ⇒ 受种技能从不注入）。
  const agent = new Agent(Runtime.createRuntime(config));
  const result = await agent.runTask('请用 sql-review 帮我审查这段数据库迁移');
  const systemTexts = result.events
    .filter((event) => event.type === 'system')
    .map((event) => String((event.payload as { content?: unknown } | undefined)?.content ?? ''));
  assert.ok(
    systemTexts.some((text) => text.includes('# 技能：sql-review') && text.includes('先看索引')),
    `技令文本必须作为 system 事件进入会话；实际 system 事件：${JSON.stringify(systemTexts)}`,
  );
});

/**
 * 与技能域无关的提示**至多**注入 1 条技能（已量化的代价，不是零噪声）。
 *
 * 这里如实钉住一个**实测发现的机制性事实**：相关性判据用的是**相对**阈值（低于最高分一半即丢），
 * 而任何有词面重叠的提示其「最高分」就是它自己 ⇒ 相对阈值**恒不会把第一名剪掉**，
 * 于是无关提示几乎总会注入**恰好 1 条**。两条技能起步才体现这一点（单技能语料下相对过滤无从判别）。
 *
 * 为什么接受这个代价：真实语料实测的收益是同量级下**压倒性**的——生产档召回 26.9% → 92.3%
 * （CI95 [46.15, 84.62]pp、留出折 0/40 为负），而代价是噪声 0.04 → 1.46 条/查询、无关提示约 1–3 条。
 * 「少给 = 能力损伤」在本仓技能场景是明确的坏方向，故宁可多给不可少给。
 * 完整数字见 `evals/skill-routing-ab.mjs`。
 */
test('端到端（真 Agent）：与技能域无关的提示至多注入 1 条技能（噪声有界，非零）', async () => {
  const other = {
    name: 'css-layout',
    description: '修 CSS 布局问题',
    instructions: '用 flex 或 grid 重排，注意盒子模型。',
    tags: ['前端', '样式'],
  };
  const config = ConfigFactory.build({
    workspaceRoot: workspace(),
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [SKILL, other],
  });
  const agent = new Agent(Runtime.createRuntime(config));
  const result = await agent.runTask('今天天气不错，下午想出去走走顺便买点水果回来');
  const injected = result.events
    .filter((event) => event.type === 'system')
    .map((event) => String((event.payload as { content?: unknown } | undefined)?.content ?? ''))
    .filter((text) => text.includes('# 技能：'));
  assert.ok(
    injected.length <= 1,
    `无关提示的注入条数必须有界（实测恰好 1 条）；实际 ${String(injected.length)} 条：${JSON.stringify(injected)}`,
  );
});

/**
 * 翻默认（2026-10-02）后的端到端证据：**同义改写**也能把技能注入进去。
 *
 * 这是判据从「字面包含」换成「BM25 相关性」的可观测后果——旧判据在这句话上必然漏召
 * （既无技能名 `sql-review`、也无 tag `数据库`/`审查`），新判据靠 instructions 正文命中。
 * 判据与三道闸的实测数字见 `evals/skill-routing-ab.mjs`（生产档召回 26.9%→92.3%、
 * CI95 [46.15, 84.62]pp、留出折 0/40 为负；假阳性分数下限 12.40 < GT 中位数 21.21）。
 */
test('端到端（真 Agent）：同义改写经相关性判据注入技能（字面判据在此必然漏召）', async () => {
  const config = ConfigFactory.build({
    workspaceRoot: workspace(),
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [SKILL],
  });
  // 前置事实：这句话在字面判据下确实命中不了（否则本用例证明不了「判据变了」）。
  assert.deepStrictEqual(
    config.skillRegistry.match('迁移脚本上线前我该按什么顺序评估风险'),
    [],
    '字面通道不应命中（本用例的前提）',
  );
  const agent = new Agent(Runtime.createRuntime(config));
  const result = await agent.runTask('迁移脚本上线前我该按什么顺序评估风险');
  const systemTexts = result.events
    .filter((event) => event.type === 'system')
    .map((event) => String((event.payload as { content?: unknown } | undefined)?.content ?? ''));
  assert.ok(
    systemTexts.some((text) => text.includes('# 技能：sql-review')),
    `同义改写必须经相关性判据注入；实际 system 事件：${JSON.stringify(systemTexts)}`,
  );
});
