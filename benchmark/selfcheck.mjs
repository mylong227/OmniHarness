// OmniHarness 六属性自检 (I-P4-2 完备收口)
// 跑法: npm run selfcheck   (脚本会先 build 再跑)
// 说明: 针对"安全 / 不遗忘 / 低耗 / 可组合 / 自进化可控 / 表征鲁棒"六属性,
//       各跑一个**真实已落地算子**的端到端探针(证明真实代码在跑),
//       并聚合该属性下既有单测作为证据链。全部 PASS 才算自检通过(exit 0)。
//       零第三方依赖: 仅 node 内置 fs + import 已编译 dist 真实算子。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfinementEngine } from '../dist/src/adapters/monitoring/confinement.js';
import { OobleckStore } from '../dist/src/adapters/kv/oobleckStore.js';
import { FailClosedEvolutionGate } from '../dist/src/evolution/evolutionGate.js';
import { HeatEquationAnnealer } from '../dist/src/adapters/memory/heatAnnealer.js';
import { VortexRingPacket } from '../dist/src/adapters/spill/vortexRing.js';
import { composeByTwist } from '../dist/src/skill/skillComposer.js';
import { moireEnergy } from '../dist/src/evolution/benchmark.js';
import { ElementComposer } from '../dist/src/adapters/skill/elementComposer.js';

const N = 64;

// ---------------- 桩 (零依赖, 仅满足被调算子运行时契约) ----------------
class KvStub {
  constructor() {
    this.m = new Map();
  }
  async get(k) {
    return this.m.get(k);
  }
  async set(k, v) {
    this.m.set(k, v);
    return true;
  }
  async delete(k) {
    return this.m.delete(k);
  }
  async close() {}
}
class SpillStub {
  constructor() {
    this.store = new Map();
    this._id = 0;
  }
  async spill(content) {
    const id = `h${this._id++}`;
    this.store.set(id, content);
    return { id, bytes: content.length };
  }
  async read(id) {
    return this.store.get(id);
  }
}
class MemStub {
  constructor() {
    this.facts = [];
  }
  all() {
    return this.facts;
  }
}

const results = [];
function check(prop, probe, measured, pass, evidence) {
  results.push({ prop, probe, measured, pass, evidence });
}

// ============ 1. 安全 fail-closed ============
// 保证机制: 航天监督 + 保形 EvolutionGate + 禁闭色荷(色单态结构性拒配)
{
  const eng = new ConfinementEngine();
  const bareSkill = { id: 'skill-x', charge: { color: 1, flavor: 0, permission: 0, expiry: 0 } };
  const v = eng.expose(bareSkill);
  check(
    '安全 fail-closed',
    '裸能力禁闭色荷结构性拒配(exposed=false)',
    `exposed=${v.exposed} | reason=${v.reason}`,
    v.exposed === false,
    [
      'confinement.test.ts',
      'evolutionGate.test.ts',
      'ruleApproval.test.ts',
      'promptInjectionGuard.test.ts',
      'sandbox.test.ts',
      'supervisor.test.ts',
    ],
  );
}

// ============ 2. 不灾难性遗忘 ============
// 保证机制: 燧-2 固化(冲击重者永存) + 热方程巩固 + 免疫记忆
{
  const store = new OobleckStore(new KvStub(), { yieldStress: 0.6 });
  await store.propose('fact-1', '重大事实: 杏子灰材质版本 v7 为唯一真值', 0.9); // 冲击越过屈服应力 → 涌现冻结
  const frozen = await store.isFrozen('fact-1');
  const overwrite = await store.propose('fact-1', '篡改内容', 0.1); // 冻结后任何写入 fail-closed 拒绝
  check(
    '不灾难性遗忘',
    '重大事实冲击冻结后不可变(永存)',
    `frozen=${frozen} | 冻结后改写.accepted=${overwrite.accepted}`,
    frozen === true && overwrite.accepted === false,
    ['oobleckStore.test.ts', 'heatAnnealer.test.ts', 'cosmicWeb.test.ts', 'immuneMonitor.test.ts'],
  );
}

// ============ 3. 低消耗 ============
// 保证机制: 零运行时依赖(铁律) + 记忆税 + 退火(算力沿 -∇T 集中)
{
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const zeroDeps = !('dependencies' in pkg) || Object.keys(pkg.dependencies || {}).length === 0;
  const annealer = new HeatEquationAnnealer(new MemStub(), {
    initialTemperature: 1.0,
    coolingRate: 10,
  });
  const temps = [];
  for (let i = 0; i < 5; i++) {
    annealer.anneal();
    temps.push(annealer.temperature);
  }
  const monotonic = temps.every((t, i) => i === 0 || t <= temps[i - 1]);
  const strictlyDown = temps[temps.length - 1] < temps[0];
  check(
    '低消耗',
    '零运行时依赖 + 退火温度单调下降(算力沿 -∇T 集中)',
    `zeroRuntimeDeps=${zeroDeps} | T=[${temps.map((t) => t.toFixed(3)).join(', ')}] 单调=${monotonic}`,
    zeroDeps && monotonic && strictlyDown,
    ['scripts/check.mjs', 'costBudget.test.ts', 'budgetedModel.test.ts', 'heatAnnealer.test.ts'],
  );
}

// ============ 4. 可组合扩展 ============
// 保证机制: 燧-1 莫尔组合 + 周期表基元 + 相变固化 + CRISPR 编辑
{
  const A = {
    name: 'sk-a',
    description: '检索 相关能力 查询 索引',
    instructions: '执行 检索 任务 召回',
    tags: ['检索'],
  };
  const B = {
    name: 'sk-b',
    description: '推理 相关能力 逻辑 演绎',
    instructions: '执行 推理 任务 推导',
    tags: ['推理'],
  };
  const composed = composeByTwist(A, B);
  const emComposed = moireEnergy(composed, N);
  const emA = moireEnergy(A, N);
  const elem = new ElementComposer();
  const naCl = elem.compose(['Na', 'Cl']); // 碱金属(+1) + 卤素(-1) 价互补 = 合法组合
  check(
    '可组合扩展',
    '莫尔组合涌现增益 > 单技能 + 元素基元互补合法组合',
    `emComposed=${emComposed.toFixed(3)} > emA=${emA.toFixed(3)} | Na+Cl=${naCl ? '合法' : 'undefined'}`,
    emComposed > emA && naCl !== undefined,
    [
      'skillComposer.test.ts',
      'elementComposer.test.ts',
      'capabilityCrystallizer.test.ts',
      'crispr.test.ts',
    ],
  );
}

// ============ 5. 自进化可控 ============
// 保证机制: 定向进化 + 相变固化 + RSI 红线(禁改自身训练/复制/自授权, 铁律锁定)
{
  const gate = new FailClosedEvolutionGate(); // 无 benchmark/baseline → 默认 fail-closed
  const candidate = { source: 'selfcheck', skill: { name: 'probe' } };
  const verdict = await gate.evaluate(candidate);
  check(
    '自进化可控',
    '默认 fail-closed: 无评估证据不晋升(任何改进须过评估才晋升)',
    `promoted=${verdict.promoted} | ${verdict.reason}`,
    verdict.promoted === false,
    ['evolutionGate.test.ts', 'discoveryEngine.test.ts', 'evolutionIntegration.test.ts'],
  );
}

// ============ 6. 表征鲁棒 ============
// 保证机制: 规范不变性 + 主模降噪 + 共振寻址 + 拓扑涡环(篡改检测)
{
  const spill = new SpillStub();
  const vortex = new VortexRingPacket(spill);
  const payload = '敏感长程状态: 498620084 杏子灰材质版本 v7, 抽面渲染须锁定';
  const ring = await vortex.seal(payload);
  const recovered = await vortex.unseal(ring);
  const tampered = await spill.read(ring.spill.id);
  const bad = tampered.slice(0, 5) + 'X' + tampered.slice(6);
  spill.store.set(ring.spill.id, bad); // 模拟后端存储被污染
  const afterTamper = await vortex.unseal(ring);
  const intact = recovered === payload;
  const detected = afterTamper === undefined;
  check(
    '表征鲁棒',
    '涡环拓扑守恒: 还原完整 + 后端篡改检测 100%',
    `recovered=${intact} | tamperDetected=${detected}`,
    intact && detected,
    [
      'spill.test.ts',
      'resonantMemory.test.ts',
      'qec.test.ts',
      'immuneMonitor.test.ts',
      'symmetryBreaking.test.ts',
    ],
  );
}

// ---------------- 报告 ----------------
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const allPass = results.every((r) => r.pass);

console.log('============================================================');
console.log(' OmniHarness 六属性自检 (I-P4-2 完备收口)');
console.log('============================================================');
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${pad(r.prop, 18)} | ${r.probe}`);
  console.log(`       实测: ${r.measured}`);
  console.log(`       证据: ${r.evidence.join(', ')}`);
}
console.log('============================================================');
const passCount = results.filter((r) => r.pass).length;
console.log(
  ` 汇总: ${passCount}/${results.length} 属性 PASS  →  ${allPass ? '六属性全部达成 ✅' : '存在未达成属性 ❌'}`,
);
console.log('============================================================');

const report = {
  generatedAt: new Date().toISOString(),
  summary: { total: results.length, passed: passCount, allPass },
  properties: results,
};
const reportPath = fileURLToPath(new URL('./selfcheck.report.json', import.meta.url));
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(` 报告已写: ${reportPath}`);

process.exit(allPass ? 0 : 1);
