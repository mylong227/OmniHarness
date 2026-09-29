/**
 * Laya 后端真跑集成测试（§34 后续待办①）：验证全链路
 * TS 适配器 → Python 桥(laya_infer.py) → 本地 `laya` 包 → 真实前向推理
 * （含首次 predict 经 `HF_ENDPOINT` 镜像拉取权重）。
 *
 * ## 门禁（可选集成测试，默认跳过，不进默认单测套件）
 *
 * - 仅当 `process.env.LAYA_PYTHON_BIN` 指向已装 `laya` 的 venv python 时启用；
 *   否则整用例 skip（不污染默认 `npm test`）。
 * - 若 `engine.isAvailable()` 为 false（后端未就绪 / 权重未下载），用例 skip
 *   （fail-open 不应使集成测试变红，真实可用性是环境前提）。
 *
 * 运行：`LAYA_PYTHON_BIN="<venv>/Scripts/python.exe" LAYA_MODEL_DIR="<本地 checkpoint 目录>" npm run test:integration`
 * 权重须本地离线放置（本机 huggingface_hub 下载受 Windows safe-delete 死结阻断，见看板 §34.7）；
 * 用例已把超时放宽到 180s 以容纳 CPU 冷加载 842MB 权重。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LayaDecisionEngine,
  type LayaDecisionEngineOptions,
} from '../../src/adapters/laya/layaDecisionEngine.js';

const pythonBin = process.env.LAYA_PYTHON_BIN;
// 本地离线 checkpoint 目录（见看板 §34.7）：权重须预下载，在线镜像拉取在本机被 safe-delete 死结阻断。
const modelDir = process.env.LAYA_MODEL_DIR ?? '';
// CPU 冷加载 842MB 权重常超 30s 默认超时，放宽到 180s。pythonPath 仅在显式设置时传入，
// 以兼容 exactOptionalPropertyTypes（undefined 不可赋给 `string`）。
const engineOpts: LayaDecisionEngineOptions = {
  modelDir,
  timeoutMs: 180_000,
  ...(pythonBin !== undefined ? { pythonPath: pythonBin } : {}),
};

test(
  'Laya 后端：noul 预判真实前向推理（含权重镜像拉取）',
  {
    skip:
      pythonBin === undefined ? '设置 LAYA_PYTHON_BIN 指向已装 laya 的 venv python 以启用' : false,
    timeout: 600_000,
  },
  async (t) => {
    const engine = new LayaDecisionEngine(engineOpts);
    if (!engine.isAvailable()) {
      t.skip('laya 后端不可用（isAvailable=false），跳过');
      return;
    }
    const response = await engine.decide({
      state: 'def write(src: string): void { fs.writeFileSync("a.txt", src); }',
      questions: {
        passTest: {
          kind: 'noul',
          instructions: '该源码写入是否通过类型与基础正确性的自检？给出 0..1 的“通过”概率。',
        },
      },
    });
    assert.strictEqual(response.available, true);
    const ans = response.answers.passTest;
    assert.ok(ans !== undefined, '应有 passTest 答案');
    assert.ok(typeof ans.noul === 'number', 'noul 应为数值');
    assert.ok(ans.noul >= 0 && ans.noul <= 1, 'noul 应在 [0,1]');
  },
);

test(
  'Laya 后端：score 原语真实前向打分',
  {
    skip:
      pythonBin === undefined ? '设置 LAYA_PYTHON_BIN 指向已装 laya 的 venv python 以启用' : false,
    timeout: 600_000,
  },
  async (t) => {
    const engine = new LayaDecisionEngine(engineOpts);
    if (!engine.isAvailable()) {
      t.skip('laya 后端不可用（isAvailable=false），跳过');
      return;
    }
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
    assert.strictEqual(response.available, true);
    const ans = response.answers.severity;
    assert.ok(ans !== undefined, '应有 severity 答案');
    assert.ok(typeof ans.score === 'number', 'score 应为数值');
    assert.ok(ans.score >= 0 && ans.score <= 2, 'score 应在 [0,2]');
  },
);
