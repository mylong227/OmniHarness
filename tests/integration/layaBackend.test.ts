/**
 * Laya 后端真跑集成测试：全链路
 * TS 适配器 → Python 桥（`laya_infer.py --serve`）→ 本地 `laya` 包 → 真实 torch 前向。
 *
 * ## 与旧版的三处关键差异（都是 2026-10「第三方 Laya 未被重用」修复的回归判据）
 *
 * 1. **不再要求手工设 `LAYA_PYTHON_BIN`**：解释器与权重由 `LayaPaths` 零配置解析
 *    （显式 → 环境变量 → 项目内 `third-party/laya-venv` + `laya-model` → 兜底）。
 *    旧版「需外部 venv 就整例 skip」正是缺陷得以长期隐形的原因之一。
 * 2. **引擎由 CLI 生产入口的默认段构造**：证明「默认配置（shadow）下后端真的可用」，
 *    而不是只在测试里手工接线才可用（旧版单测全绿、默认运行时零调用）。
 * 3. **覆盖三条原语 + 热进程复用**：noul / choice / score 都验真实数值，
 *    并断言热路径单次 < 5s（实测约 0.4s；单发路径每次 18–62s，是「用不起」的根因）。
 *
 * 缺 venv / 权重时整个文件 skip（fail-open 不应使集成测试变红，真实可用性是环境前提）。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.js';
import { LayaPaths } from '../../src/adapters/laya/layaPaths.js';
import { DecisionEngineResolver } from '../../src/config/decisionEngineResolver.js';
import { CliDecisionEngineFlags } from '../../src/cli/cliDecisionEngineFlags.js';
import { CliDefaults } from '../../src/cli/argParser.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';

/** 项目内解释器（零配置解析：环境变量 → 项目内 venv → 兜底）。 */
const venvPython = LayaPaths.pythonPath(process.cwd());
/** 项目内权重目录（空串 = 未安装）。 */
const localModelDir = LayaPaths.modelDir(process.cwd());
/** 缺环境即 skip 的原因（false = 照跑）。 */
const SKIP: string | false =
  existsSync(venvPython) && localModelDir.length > 0
    ? false
    : `项目内未安装 Laya 运行时（解释器 ${venvPython} / 权重 ${localModelDir.length > 0 ? localModelDir : '(缺失)'}）——见 THIRD_PARTY_ASSETS.md 的重建步骤`;

/**
 * 用「CLI 生产入口的默认决策引擎段」构造适配器（即默认配置下的真实装配路径）。
 * @returns 适配器实例。
 */
function engineFromDefaultConfig(): LayaDecisionEngine {
  const section = CliDecisionEngineFlags.resolve({ ...CliDefaults, prompt: 'laya 集成测试' });
  assert.ok(section !== undefined, '生产入口默认应装配决策引擎');
  const engine = new DecisionEngineResolver().resolve({
    decisionEngine: section,
  } as unknown as OmniHarnessConfig);
  assert.ok(engine instanceof LayaDecisionEngine, '默认配置应构造 LayaDecisionEngine');
  return engine;
}

/** 共享引擎：首帧付一次权重加载（实测 12.7s），后续用例吃热路径。 */
const engine = engineFromDefaultConfig();

/**
 * 显式预热：`warmUp` 会等到权重就绪（而不是让每个 decide 各自撞 1.5s 冷启动预算 fail-open）。
 * 这正是「调用方明确愿意付一次冷启动代价」的场景——默认路径（自验证回环）不会这么做。
 */
before(async () => {
  if (SKIP === false) {
    const ready = await engine.warmUp(300_000);
    assert.strictEqual(ready, true, '热进程应在 300s 内完成权重加载');
  }
});

after(() => {
  engine.dispose();
});

test(
  'Laya 默认配置：零配置解析到项目内 venv + 权重，且后端真实可用',
  { skip: SKIP, timeout: 600_000 },
  async () => {
    const resolution = engine.resolution();
    assert.strictEqual(resolution.pythonPath, venvPython, '解释器应解析到项目内 venv');
    assert.strictEqual(resolution.modelDir, localModelDir, '权重应解析到项目内 laya-model');
    assert.strictEqual(resolution.warm, true, '默认启用常驻热进程');
    assert.strictEqual(await engine.isAvailable(), true, '默认配置下 Laya 后端必须真的可用');
  },
);

test('Laya noul：真实前向给出 [0,1] 概率', { skip: SKIP, timeout: 600_000 }, async () => {
  const response = await engine.decide({
    state: 'the test suite failed twice in a row on the same file',
    questions: {
      passTest: {
        kind: 'noul',
        instructions: '这次源码改动会跑通既有测试吗？给出 0..1 的概率。',
      },
    },
  });
  assert.strictEqual(response.available, true, response.note ?? '');
  const answer = response.answers.passTest;
  assert.ok(answer !== undefined, '应有 passTest 答案');
  assert.ok(typeof answer.noul === 'number' && Number.isFinite(answer.noul), 'noul 应为有限数');
  assert.ok(answer.noul >= 0 && answer.noul <= 1, `noul 应在 [0,1]（实测 ${answer.noul}）`);
});

test('Laya choice：真实前向选中 criteria 内的类别', { skip: SKIP, timeout: 600_000 }, async () => {
  const response = await engine.decide({
    state: 'function add(a, b) { return a + b; }',
    questions: {
      verdict: {
        kind: 'choice',
        instructions: '这个实现需要修改吗？',
        criteria: { 需要修改: '', 不需要修改: '' },
      },
    },
  });
  assert.strictEqual(response.available, true, response.note ?? '');
  const answer = response.answers.verdict;
  assert.ok(answer !== undefined, '应有 verdict 答案');
  assert.ok(
    answer.choice === '需要修改' || answer.choice === '不需要修改',
    `choice 必须是 criteria 内的类别（实测 ${String(answer.choice)}）`,
  );
});

test('Laya score：真实前向给出 [0,2] 有序打分', { skip: SKIP, timeout: 600_000 }, async () => {
  const response = await engine.decide({
    state: 'function add(a, b) { return a + b; }',
    questions: {
      severity: {
        kind: 'score',
        instructions: '该函数的实现质量评分（0=差，2=优）。',
        criteria: ['差', '中', '优'],
      },
    },
  });
  assert.strictEqual(response.available, true, response.note ?? '');
  const answer = response.answers.severity;
  assert.ok(answer !== undefined, '应有 severity 答案');
  assert.ok(typeof answer.score === 'number' && Number.isFinite(answer.score), 'score 应为有限数');
  assert.ok(answer.score >= 0 && answer.score <= 2, `score 应在 [0,2]（实测 ${answer.score}）`);
});

test(
  'Laya 热路径：连续三次决策都在秒级（退化成单发即为 18–62s/次）',
  { skip: SKIP, timeout: 600_000 },
  async () => {
    // 判据口径（2026-10-07 评审订正）：原名写「热进程复用」却只断言一次 < 5s —— 单发路径在暖盘
    // 缓存下也可能 < 5s，于是「热进程没生效」这条回归抓不住。现在连续三次计时：单发路径每次都要
    // 重载 842MB 权重（实测 18–62s），三次全在秒级才说明复用确实生效。
    // （进程复用的**硬证据**——两次请求落到同一 pid——由 `tests/unit/layaWarmWorker.test.ts` 用
    //  同构协议的替身进程锁死，那里不依赖真实权重，跑得也快。）
    const elapsed: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      const response = await engine.decide({
        state: `const x${i}: number = ${i};`,
        questions: {
          passTest: { kind: 'noul', instructions: '这段代码能通过类型检查吗？' },
        },
      });
      elapsed.push(Date.now() - started);
      assert.strictEqual(response.available, true, response.note ?? '');
    }
    for (const [index, ms] of elapsed.entries()) {
      assert.ok(
        ms < 5000,
        `第 ${index + 1} 次决策应 < 5s（实测 ${ms}ms；接近 18s 说明退化成单发路径）`,
      );
    }
  },
);
