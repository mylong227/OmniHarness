/**
 * Laya 决策引擎配置解析单测（权威缝：配置 → 适配器构造 → 路径解析）。
 *
 * ## 锁死三件事（都是 2026-10 实测缺陷的直接回归）
 *
 * ① `DecisionEngineResolver` 是组合根里「配置 → 决策引擎适配器」的**唯一构造点**：
 *    `off` / 缺省返回 `undefined`（不装配、零行为）；`shadow` / `enforce` 构造实例；
 * ② **零配置解析**：适配器的解释器不再硬编码 `python3`，而是走 `LayaPaths`（显式 → 环境变量
 *    → 项目内 venv → 兜底）。这条判据在本机（项目内 venv 存在）会让「改回硬编码」立刻变红；
 * ③ **配置面可达**：`omniharness.json` 接受 `decisionEngine` 段（此前是「未知配置项」直接拒绝，
 *    于是引擎只能编程注入 —— 而编程注入的部署里 mode 从未被打开），且非法段 fail-closed。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { LayaDecisionEngine } from '../../src/adapters/laya/layaDecisionEngine.js';
import { LayaPaths } from '../../src/adapters/laya/layaPaths.js';
import { DecisionEngineResolver } from '../../src/config/decisionEngineResolver.js';
import { CliDecisionEngineFlags } from '../../src/cli/cliDecisionEngineFlags.js';
import { CliDefaults } from '../../src/cli/argParser.js';
import type { CliArgs } from '../../src/cli/argParser.js';
import { ConfigError } from '../../src/config/configError.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import type { DecisionEngineConfig } from '../../src/ports/config/decisionEngineConfig.js';

const resolver = new DecisionEngineResolver();

/** 解释器环境变量名（与适配器解析链同源）。 */
const PYTHON_ENV = 'LAYA_PYTHON_BIN';

/**
 * 在临时环境变量下执行一段断言，结束后恢复原值。
 * @param value 临时值（undefined 表示删除）。
 * @param run 待执行断言。
 * @returns 无返回值。
 */
function withPythonEnv(value: string | undefined, run: () => void): void {
  const saved = process.env[PYTHON_ENV];
  if (value === undefined) {
    delete process.env[PYTHON_ENV];
  } else {
    process.env[PYTHON_ENV] = value;
  }
  try {
    run();
  } finally {
    if (saved === undefined) {
      delete process.env[PYTHON_ENV];
    } else {
      process.env[PYTHON_ENV] = saved;
    }
  }
}

/**
 * 用给定决策引擎段解析出适配器实例（断言其类型后返回）。
 * @param decisionEngine 决策引擎配置段。
 * @returns 适配器实例。
 */
function resolveEngine(decisionEngine: DecisionEngineConfig): LayaDecisionEngine {
  const cfg = { decisionEngine } as unknown as OmniHarnessConfig;
  const engine = resolver.resolve(cfg);
  assert.ok(engine instanceof LayaDecisionEngine, '应构造 LayaDecisionEngine 实例');
  return engine;
}

test('DecisionEngineResolver：off / 缺省不装配（undefined）', () => {
  const off = { decisionEngine: { mode: 'off' as const } } as unknown as OmniHarnessConfig;
  assert.strictEqual(resolver.resolve(off), undefined);
  const none = {} as unknown as OmniHarnessConfig;
  assert.strictEqual(resolver.resolve(none), undefined);
});

test('DecisionEngineResolver：shadow 构造实例并启用热进程', () => {
  const engine = resolveEngine({ mode: 'shadow' });
  assert.strictEqual(engine.name, 'laya');
  assert.strictEqual(engine.resolution().warm, true, '默认复用常驻热进程（否则每次 18–62s）');
});

test('适配器解析链：解释器走 LayaPaths（项目内 venv 存在时必须是它）', () => {
  withPythonEnv(undefined, () => {
    const engine = resolveEngine({ mode: 'shadow' });
    const resolution = engine.resolution();
    assert.ok(resolution.scriptPath.endsWith('laya_infer.py'));
    assert.strictEqual(
      resolution.pythonPath,
      LayaPaths.pythonPath(dirname(resolution.scriptPath)),
      '解释器必须经 LayaPaths 解析（显式 → 环境变量 → 项目内 venv → 兜底）',
    );
    // 强判据（2026-10-07 评审指出上一版是「实现与自身比较」的同义反复）：本仓 venv 存在时，
    // 解析结果必须**就是那个 venv 解释器**；否则「装好了却没接上」会再次无声发生。
    const root = LayaPaths.projectRoot(dirname(resolution.scriptPath));
    const venvPython = root.length > 0 ? LayaPaths.venvPython(root) : '';
    if (venvPython.length > 0 && existsSync(venvPython)) {
      assert.strictEqual(
        resolution.pythonPath,
        venvPython,
        '项目内 venv 存在时必须解析到它（这是原始缺陷的现场：默认值指向无 laya 的系统 python3）',
      );
    }
  });
});

test('适配器解析链：显式 pythonPath / 环境变量都能覆盖', () => {
  assert.strictEqual(
    resolveEngine({ mode: 'shadow', pythonPath: '/x/python' }).resolution().pythonPath,
    '/x/python',
  );
  withPythonEnv('/env/python', () => {
    assert.strictEqual(resolveEngine({ mode: 'shadow' }).resolution().pythonPath, '/env/python');
    assert.strictEqual(
      resolveEngine({ mode: 'shadow', pythonPath: '/explicit/python' }).resolution().pythonPath,
      '/explicit/python',
      '显式配置优先于环境变量',
    );
  });
});

test('适配器解析链：warm:false / modelDir / timeoutMs 逐字段透传到适配器', () => {
  assert.strictEqual(resolveEngine({ mode: 'shadow', warm: false }).resolution().warm, false);
  assert.strictEqual(
    resolveEngine({ mode: 'shadow', modelDir: '/explicit/model' }).resolution().modelDir,
    '/explicit/model',
  );
  assert.strictEqual(
    resolveEngine({ mode: 'shadow', warm: false, modelDir: '/explicit/model' }).resolution().warm,
    false,
  );
  // `timeoutMs` 必须真的约束热路径（二轮评审：原先只有文档这么说，代码与判据都没有）。
  const capped = resolveEngine({ mode: 'shadow', timeoutMs: 2000 }).resolution();
  assert.strictEqual(capped.warmRequestTimeoutMs, 2000, 'timeoutMs 更小时应取它');
  const cappedBig = resolveEngine({ mode: 'shadow', timeoutMs: 600_000 }).resolution();
  assert.strictEqual(cappedBig.warmRequestTimeoutMs, 15_000, 'timeoutMs 更大时取热路径默认上限');
  assert.strictEqual(cappedBig.loadTimeoutMs, 180_000, '加载预算必须有界（默认 3 分钟）');
});

test('CLI 解析：生产入口默认 shadow（跑、记、不改行为）', () => {
  const defaults: CliArgs = { ...CliDefaults, prompt: 'x' };
  const section = CliDecisionEngineFlags.resolve(defaults);
  assert.ok(section !== undefined, '生产入口默认必须装配引擎（此前两处都是 off 且无用户面入口）');
  assert.strictEqual(section.mode, 'shadow');
  assert.strictEqual(section.pythonPath, undefined, '未显式给出解释器时交给适配器零配置解析');
});

test('CLI 解析：--decision-engine / 配置文件 / --no-decision-engine 的优先级', () => {
  const base: CliArgs = { ...CliDefaults, prompt: 'x' };
  assert.strictEqual(
    CliDecisionEngineFlags.resolve({ ...base, decisionEngineMode: 'off' }),
    undefined,
    'off 不写 partial（不装配即零行为）',
  );
  assert.strictEqual(
    CliDecisionEngineFlags.resolve({ ...base, decisionEngine: { mode: 'off' } }),
    undefined,
  );
  assert.strictEqual(
    CliDecisionEngineFlags.resolve({ ...base, decisionEngine: { mode: 'enforce' } })?.mode,
    'enforce',
  );
  assert.strictEqual(
    CliDecisionEngineFlags.resolve({
      ...base,
      decisionEngine: { mode: 'enforce' },
      decisionEngineMode: 'shadow',
    })?.mode,
    'shadow',
    '旗标优先于配置文件',
  );
});

test('CLI 解析：解释器旗标优先，其余字段从配置文件段透传', () => {
  const section = CliDecisionEngineFlags.resolve({
    ...CliDefaults,
    prompt: 'x',
    decisionEngine: {
      mode: 'shadow',
      pythonPath: '/file/python',
      modelDir: '/file/model',
      repo: 'convaiinnovations/laya',
      warm: false,
      timeoutMs: 1000,
      trace: false,
    },
    decisionEnginePython: '/flag/python',
  });
  assert.deepStrictEqual(section, {
    mode: 'shadow',
    pythonPath: '/flag/python',
    modelDir: '/file/model',
    repo: 'convaiinnovations/laya',
    warm: false,
    timeoutMs: 1000,
    trace: false,
  });
});

test('配置文件面：decisionEngine 段合法即接受，非法即 fail-closed', () => {
  const accepted = ConfigError.normalizeConfig({
    decisionEngine: { mode: 'shadow', pythonPath: '/p/python' },
  });
  assert.deepStrictEqual(accepted.decisionEngine, { mode: 'shadow', pythonPath: '/p/python' });

  assert.throws(
    () => ConfigError.normalizeConfig({ decisionEngine: { mode: 'sometimes' } }),
    /decisionEngine\.mode/,
  );
  assert.throws(
    () => ConfigError.normalizeConfig({ decisionEngine: { pythonpath: '/p' } }),
    /未知 key/,
  );
  assert.throws(
    () => ConfigError.normalizeConfig({ decisionEngine: { timeoutMs: 'soon' } }),
    /timeoutMs/,
  );
  // 拼错的顶层 key 同样拒绝（这一段静默失效的代价是「引擎恒不构造且无告警」）。
  assert.throws(() => ConfigError.normalizeConfig({ decisionengine: {} }), /未知配置项/);
});
