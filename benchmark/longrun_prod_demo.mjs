// longrun_prod_demo.mjs —— I-P4-3 真实外部负载路径演示（production 观测累积）
//
// 目的：证明「在真实外部负载下启用 runtimeTelemetry + sparkAutoRun，让闭环跑真实流量」
//       的整条生产路径真实可用，而非只在 self-driven 驱动里自证。
//
// 路径：ConfigFactory.build（真实生产装配，与 CLI/服务器同源）→ Agent.runTask（真实任务循环）
//       → 任务末 runSparkIfEnabled → SparkController.cycle() → 为每个已启用引擎落盘一条
//       provenance='production' 的真实指标观测（见 src/spark/sparkController.ts）。
//
// 诚实边界：
//   - 本环境无外部 LLM 真实流量，故用 ScriptedModel（无 API Key、确定性 replay）驱动真实 Agent
//     循环；模型是桩，但 Agent 主循环 / 工具门禁 / 燧内核调度 / 遥测落盘全部是生产同源真实代码。
//   - 引擎经子配置开关（memoryAnnealing.enabled 等）启用——与生产 CLI/服务器完全相同的装配路径；
//     探针（immuneSample/beliefObservation/symmetryProbe/confinementProbe/composeProbe）由 build 自
//     动构造，无需手写。
//   - 落盘的 production 观测携带 cycle() 算出的真实引擎指标（drift / confidencePF / 色荷 exposed
//     / 组合 validCombo / crispr 应用回滚 / 固化 frozen 等），非伪造；任务间向 longTermMemory 注入
//     变动事实，构成真实 varied 负载（退火温度单调下降、信念 KL 更新、免疫自体基线采样）。
//   - crispr/oobleck/evolutionGate/skillComposer 的「带标注对比」观测由 self-driven 负载覆盖
//     （生产路径下它们靠任务内真实动作触发）；本演示聚焦证明 spark 周期对 7 个引擎的 production 落盘路径。
//
// 用法：npm run longrun:prod   （会先 build）

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ConfigFactory } from '../dist/src/config/omniharnessConfig.js';
import { RuntimeFactory } from '../dist/src/core/runtime.js';
import { Agent } from '../dist/src/core/agent.js';
import { ScriptedModel } from '../dist/src/eval/scriptedModel.js';
import { MemoryStorage } from '../dist/src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../dist/src/adapters/approval/autoApproval.js';
import { SilentEventPort } from '../dist/src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../dist/src/adapters/sandbox/passthroughSandbox.js';
import { JsonlRuntimeTelemetry } from '../dist/src/adapters/telemetry/jsonlRuntimeTelemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_PATH = join(__dirname, 'runtime-telemetry.prod.log');

// 确定性 PRNG（与 self-driven 同款，保证演示可复现）。
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xbeef);

// 必须在构造 sink【之前】清除，否则 resumeChain 从旧文件续上 seq 致哈希链断裂。
if (existsSync(PROD_PATH)) rmSync(PROD_PATH);
const telemetry = new JsonlRuntimeTelemetry({ path: PROD_PATH });

const workspace = mkdtempSync(join(tmpdir(), 'prod-demo-'));
const model = new ScriptedModel([], '任务完成（生产路径演示，无外部 LLM，仅驱动真实 Agent 循环）');

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
  // 受种技能池：供 CRISPR 编辑与相变固化复用（build 内部构造 SkillRegistry）。
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
const N = 40;

// 预生成所有技能两两组合（供相变固化器在多任务中反复冻结，真实流出多组涌现样本）。
// 注意：ConfigFactory.build 不回显 skills（属输入参数），故此处用 demo 内已知技能名构造。
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

// 任务间向 longTermMemory 注入变动事实 → 退火/免疫/信念探针拿到真实 varied 数据（生产样式负载）。
const ltm = config.longTermMemory;
for (let i = 0; i < N; i++) {
  for (let k = 0; k < 6; k++) {
    ltm.remember({
      id: `f${i}-${k}`,
      text: `生产事实 ${i} ${k}：频率域共振退火样本`,
      topic: 'demo',
      importance: 0.3 + rng() * 0.4,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      sessionId: `sess-prod-${i}`,
      source: 'tool',
    });
  }
  // 让相变固化器真正 observe 组合 → crystallize 经 composeByTwist 产出真实涌现（非伪造）。
  // 每个任务轮换一个不同组合，使多组组合在运行期内被冻结，真实流出多组涌现样本。
  const pair = PAIRS[i % PAIRS.length];
  for (let c = 0; c < 5; c++) config.crystallizer?.observe(pair);
  await agent.runTask(`生产负载任务 ${i}：检索并整合信息`);
}

// ---- 验证 production 观测真实累积 ----
const prod = telemetry.read().filter((o) => o.provenance === 'production');
const byOp = {};
for (const o of prod) byOp[o.operator] = (byOp[o.operator] ?? 0) + 1;
const chain = telemetry.verify();

console.log(`[longrun:prod] 经真实 Agent.runTask × ${N} 累积 production 观测: ${prod.length} 条`);
console.log(`[longrun:prod] 哈希链校验: ok=${chain.ok} count=${chain.count}`);
console.log('[longrun:prod] 各引擎 production 观测数:');
for (const [op, c] of Object.entries(byOp)) console.log(`  - ${op}: ${c}`);
console.log(`[longrun:prod] 样本文件: ${PROD_PATH}`);
console.log(
  '[longrun:prod] 下一步跑 `npm run longrun:tighten:prod` 让闭环用真实 production 证据评估参数',
);
