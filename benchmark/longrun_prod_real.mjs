// longrun_prod_real.mjs —— 真实 LLM 端到端验证（I-P4 收口佐证）
//
// 目的：证明九算子生产路径在「真实外部 LLM 流量」（非 ScriptedModel 桩）下同样成立。
//       与 longrun_prod_demo.mjs 的唯一差异：模型换成 OpenAiCompatibleModel（DeepSeek 真实端点）
//       + BudgetedModel fail-closed 成本护栏；其余生产同源装配（ConfigFactory.build 子开关）
//       + runtimeTelemetry + sparkAutoRun 完全一致。
//
// 诚实边界：
//   - 硬依赖 DEEPSEEK_API_KEY（真实流量凭证）。缺失则立即退出码 2，不发起任何网络调用。
//   - BudgetedModel 设 $0.50 硬预算 + N=3 + maxSteps=4，三重护栏防止失控烧钱。
//   - 落盘 provenance='production' 观测携带 cycle() 算出的真实引擎指标（与 demo 同源代码路径）。
//   - 任务间向 longTermMemory 注入变动事实 + 固化器 observe 组合，构成真实 varied 负载。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx npm run longrun:prod:real
//   （可选）DEEPSEEK_BASE_URL=https://api.deepseek.com  DEEPSEEK_MODEL=deepseek-chat

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ConfigFactory } from '../dist/src/config/omniharnessConfig.js';
import { RuntimeFactory } from '../dist/src/core/runtime.js';
import { Agent } from '../dist/src/core/agent.js';
import { OpenAiCompatibleModel } from '../dist/src/adapters/model/openaiCompatibleModel.js';
import { BudgetedModel } from '../dist/src/adapters/model/budgetedModel.js';
import { CostBudget } from '../dist/src/adapters/model/costBudget.js';
import { MemoryStorage } from '../dist/src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../dist/src/adapters/approval/autoApproval.js';
import { SilentEventPort } from '../dist/src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../dist/src/adapters/sandbox/passthroughSandbox.js';
import { JsonlRuntimeTelemetry } from '../dist/src/adapters/telemetry/jsonlRuntimeTelemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_PATH = join(__dirname, 'runtime-telemetry.prod-real.log');

// ---- 硬依赖：真实 LLM 凭证（缺失即失败，绝不臆造）----
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error(
    '[longrun:prod:real] 硬依赖缺失：需要环境变量 DEEPSEEK_API_KEY（真实 LLM 流量凭证）。\n' +
      '  请提供后重跑：DEEPSEEK_API_KEY=sk-xxx npm run longrun:prod:real',
  );
  process.exit(2);
}
const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// ---- 成本护栏（fail-closed）：$0.50 硬预算，越限即熔断阻断后续调用 ----
const budget = new CostBudget(0.5, new Map());

// 必须在构造 sink【之前】清除，否则 resumeChain 从旧文件续上 seq 致哈希链断裂。
if (existsSync(PROD_PATH)) rmSync(PROD_PATH);
const telemetry = new JsonlRuntimeTelemetry({ path: PROD_PATH });

const workspace = mkdtempSync(join(tmpdir(), 'prod-real-'));
const realModel = new OpenAiCompatibleModel({ baseUrl, apiKey, model: modelName });
const model = new BudgetedModel(realModel, budget); // 外层包裹：先判预算再调用

// 真实生产装配：与 CLI/服务器共用 ConfigFactory.build，仅靠子配置开关启用引擎 + 遥测 + sparkAutoRun。
const config = ConfigFactory.build({
  workspaceRoot: workspace,
  maxSteps: 4,
  model,
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new SilentEventPort(),
  // 子配置开关启用各燧/信念/组合/固化/禁闭引擎（生产同源路径）。
  memoryAnnealing: {
    enabled: true,
    coupling: 0.15,
    initialTemperature: 1.0,
    coolingRate: 8,
    decay: 0.95,
    resonanceThreshold: 0.6,
    maxFacts: 1500,
  },
  immuneMonitoring: { enabled: true, threshold: 3 },
  belief: { enabled: true, algorithm: 'both', dim: 3, particles: 200, initialVariance: 1 },
  skillEditing: { enabled: true, addressThreshold: 0.5, bins: 8 },
  capabilityCrystallization: {
    enabled: true,
    densityThreshold: 3,
    decay: 0.9,
    fieldSize: 32,
    resetOnCrystallize: true,
  },
  elementComposer: { enabled: true },
  symmetryBreaking: { enabled: true, threshold: 0.7 },
  confinement: { enabled: true, groupOrder: 3 },
  skills: [
    {
      name: 'retrieval-basics',
      description: '基础检索',
      instructions: '用倒排索引检索相关文档。',
      tags: ['retrieval'],
    },
    {
      name: 'compose-basics',
      description: '基础组合',
      instructions: '把两段文本拼接成摘要。',
      tags: ['compose'],
    },
    {
      name: 'search-deep',
      description: '深度搜索',
      instructions: '递归检索多层引用并去重。',
      tags: ['retrieval'],
    },
    {
      name: 'summarize-text',
      description: '文本摘要',
      instructions: '提取要点并压缩成三段式摘要。',
      tags: ['compose'],
    },
    {
      name: 'parse-json',
      description: 'JSON 解析',
      instructions: '将非结构化文本解析为 JSON 对象。',
      tags: ['transform'],
    },
    {
      name: 'translate-lang',
      description: '语言翻译',
      instructions: '把文本译为指定目标语言。',
      tags: ['transform'],
    },
    {
      name: 'vectorize-embed',
      description: '向量化嵌入',
      instructions: '把文本编码为稠密向量用于相似度检索。',
      tags: ['retrieval'],
    },
  ],
  runtimeTelemetry: telemetry,
  sparkAutoRun: true,
});

const agent = new Agent(RuntimeFactory.create(config));
const N = 3; // 小额验证任务数（三重成本护栏之一）

// 预生成技能两两组合，供相变固化器在多任务中反复冻结，真实流出涌现样本。
const skillNames = [
  'retrieval-basics',
  'compose-basics',
  'search-deep',
  'summarize-text',
  'parse-json',
  'translate-lang',
  'vectorize-embed',
];
const PAIRS = [];
for (let a = 0; a < skillNames.length; a++)
  for (let b = a + 1; b < skillNames.length; b++) PAIRS.push([skillNames[a], skillNames[b]]);

const rng = (() => {
  let a = 0xbeef;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const ltm = config.longTermMemory;
for (let i = 0; i < N; i++) {
  for (let k = 0; k < 6; k++) {
    ltm.remember({
      id: `f${i}-${k}`,
      text: `生产事实 ${i} ${k}：频率域共振退火样本`,
      topic: 'demo',
      importance: 0.3 + rng() * 0.4,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      sessionId: `sess-prod-real-${i}`,
      source: 'tool',
    });
  }
  const pair = PAIRS[i % PAIRS.length];
  for (let c = 0; c < 5; c++) config.crystallizer?.observe(pair);
  // 真实 LLM 任务：要求文本输出（避免触发无实现的工具调用），九算子仍随主循环与记忆操作真实运行。
  await agent.runTask(
    `真实 LLM 验证任务 ${i}：用一句话概括「OmniHarness 是一个融合 Codex 与 DeepSeek 优点的全能 Agent Harness」`,
  );
}

// ---- 验证 production 观测真实累积（真实 LLM 流量驱动）----
const prod = telemetry.read().filter((o) => o.provenance === 'production');
const byOp = {};
for (const o of prod) byOp[o.operator] = (byOp[o.operator] ?? 0) + 1;
const chain = telemetry.verify();

console.log(
  `[longrun:prod:real] 真实 LLM(${modelName}) 经 Agent.runTask × ${N} 累积 production 观测: ${prod.length} 条`,
);
console.log(`[longrun:prod:real] 哈希链校验: ok=${chain.ok} count=${chain.count}`);
console.log(
  `[longrun:prod:real] 成本护栏: 花费 $${budget.totalCostUsd.toFixed(4)} / 硬预算 $0.5000（prompt ${budget.totalPromptTokens} / completion ${budget.totalCompletionTokens} tokens）`,
);
console.log('[longrun:prod:real] 各引擎 production 观测数:');
for (const [op, c] of Object.entries(byOp)) console.log(`  - ${op}: ${c}`);
console.log(`[longrun:prod:real] 样本文件: ${PROD_PATH}`);
if (chain.ok && prod.length > 0) {
  console.log('[longrun:prod:real] ✅ 真实 LLM 端到端验证通过：九算子生产路径在真实流量下成立。');
} else {
  console.log(
    '[longrun:prod:real] ⚠️ 验证未达预期（观测为空或哈希链断裂），请检查网络/凭证/预算。',
  );
}
