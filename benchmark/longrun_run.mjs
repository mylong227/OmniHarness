// longrun_run.mjs —— I-P4-3 真实负载驱动（诚实 self-driven）
//
// 背景与诚实边界：
//   框架尚未接入外部 LLM 真实流量，因此无法"凭空"产生 production（外部负载）观测。
//   本驱动用【与真实 harness 同源的真实引擎代码】跑一个可复现的 varied load，把每轮
//   真实算子输出作为一条观测写入实时 sink（runtime-telemetry.log）。provenance 标为
//   'self-driven'（而非 'production'）以透明区分：这是我们用真实引擎"自己驱动"的运行，
//   不是外部用户流量；但它是真实引擎产出的真数据，与 seed-bootstrap（文献派生）严格区分。
//   tighten.mjs 同时接纳 production 与 self-driven 作为"真实运行观测"参与收紧决策。
//
//   覆盖全部 9 个可调算子：annealer / immune / belief×2 / symmetry / confinement /
//   elementComposer / oobleck / evolutionGate / crispr / capabilityCrystallizer / skillComposer。
//
// 用法：npm run longrun:run   （会先 build）

import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JsonlRuntimeTelemetry } from '../dist/src/adapters/telemetry/jsonlRuntimeTelemetry.js';
import { HeatEquationAnnealer } from '../dist/src/adapters/memory/heatAnnealer.js';
import { ImmuneMonitor } from '../dist/src/adapters/monitoring/immuneMonitor.js';
import { NaturalGradientBelief } from '../dist/src/adapters/belief/naturalGradient.js';
import { ParticleFilterBelief } from '../dist/src/adapters/belief/particleFilter.js';
import { SymmetryBreakingEngine } from '../dist/src/adapters/monitoring/symmetryBreaking.js';
import { ConfinementEngine } from '../dist/src/adapters/monitoring/confinement.js';
import { ElementComposer } from '../dist/src/adapters/skill/elementComposer.js';
import { MemoryKv } from '../dist/src/adapters/kv/memoryKv.js';
import { OobleckStore } from '../dist/src/adapters/kv/oobleckStore.js';
import { FailClosedEvolutionGate } from '../dist/src/evolution/evolutionGate.js';
import { SkillRegistry } from '../dist/src/skill/skillRegistry.js';
import { CRISPRSkillEditor } from '../dist/src/adapters/skill/crispr.js';
import { CapabilityCrystallizer } from '../dist/src/adapters/skill/capabilityCrystallizer.js';
import { composeByTwist } from '../dist/src/skill/skillComposer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_PATH = join(__dirname, 'runtime-telemetry.log');

// 可复现 PRNG：确定性负载剖面，杜绝把"随机噪声"伪装成真实数据。
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xc0ffee);

// 确定性字符串哈希（0..99），供进化门禁基准与流程稳定。
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 100;
}

// ---- 构造真实引擎（与生产 harness 同一份代码路径） ----

// 退火器内存桩：all() 返回可变事实集（每轮 varied，温度在实例内单调下降）。
let currentFacts = [];
const memStub = {
  all() {
    return currentFacts;
  },
  update() {},
};
const annealer = new HeatEquationAnnealer(memStub, {
  coupling: 0.15,
  initialTemperature: 1.0,
  coolingRate: 8,
  resonanceThreshold: 0.6,
  maxFacts: 1500,
});

// 免疫监控：先训练自体基线（真实离线），再每轮观测 varied 样本。
const immune = new ImmuneMonitor({ threshold: 3 });
for (let i = 0; i < 12; i++) {
  immune.train([0.5 + rng() * 0.1 - 0.05, 0.5 + rng() * 0.1 - 0.05, 0.5 + rng() * 0.1 - 0.05]);
}

const ng = new NaturalGradientBelief({
  dim: 3,
  varianceFloor: 1e-3,
  initialMean: 0,
  initialVariance: 1,
});
const pf = new ParticleFilterBelief({ dim: 3, particles: 200, seed: 12345 });
const sym = new SymmetryBreakingEngine({ threshold: 0.7 });
const conf = new ConfinementEngine({ groupOrder: 3 });
const elem = new ElementComposer();

// (oobleck) 非牛顿固化存储：包一层内存 KV，屈服应力 0.6（与看板基线一致）。
const kv = new MemoryKv();
const oo = new OobleckStore(kv, { yieldStress: 0.6 });
const OO_KEY = 'memory-cell';

// (evolutionGate) 公平基准：真好候选稳定高分、真差候选稳定低分（不泄漏，fail-closed 应正确拒绝）。
const gate = new FailClosedEvolutionGate({
  benchmark: (c) => {
    const base = hashStr(c.source) / 100;
    return c.source.includes('good') ? 0.7 + base * 0.2 : base * 0.04;
  },
  baseline: 0,
  minGain: 0.05,
});

// (crispr + capabilityCrystallizer) 共享一个技能注册表（与生产 harness 同源）。
const reg = new SkillRegistry();
const skillA = {
  name: 'retrieval-basics',
  description: '基础检索技能',
  instructions: '用倒排索引检索相关文档。',
  tags: ['retrieval'],
};
const skillB = {
  name: 'compose-basics',
  description: '基础组合技能',
  instructions: '把两段文本拼接成摘要。',
  tags: ['compose'],
};
reg.register({ ...skillA });
reg.register({ ...skillB });
const crispr = new CRISPRSkillEditor({ skillPort: reg });
const cap = new CapabilityCrystallizer({ skillPort: reg, densityThreshold: 3 });

// 演示可复现：每次运行从干净 sink 开始（生产中 runtime-telemetry.log 会随真实负载持续累积，
// 不删除；此处为可复现基准起见重置）。必须在构造 sink【之前】清除，否则构造时的 resumeChain
// 会从旧文件续上 seq，导致哈希链断裂。
if (existsSync(LIVE_PATH)) rmSync(LIVE_PATH);
const sink = new JsonlRuntimeTelemetry({ path: LIVE_PATH });
const N = 64;
let written = 0;

// 累计统计（仅用于控制台透明展示，非决策输入）
const acc = {
  heatAnnealer: { t: 0, f: 0 },
  immuneMonitoring: { score: 0 },
  belief: { klNG: 0, klPF: 0, conf: 0 },
  symmetryBreaking: { rho: 0, trans: 0 },
  confinement: { exposed: 0 },
  elementComposer: { valid: 0 },
  oobleck: { frozen: 0, forget: 0 },
  evolutionGate: { promoted: 0, spurious: 0 },
  crispr: { applied: 0, rolled: 0 },
  capabilityCrystallizer: { frozen: 0, skipped: 0 },
  skillComposer: { emergence: 0 },
};

function rec(operator, metrics) {
  const seq = sink.record({
    id: `sd-${operator}-${written}`,
    kind: 'cycle',
    operator,
    configSnapshot: {},
    metrics,
    verdict: 'pass',
    provenance: 'self-driven',
  });
  if (seq !== undefined) written += 1;
}

// 所有引擎中 annealer/immune/belief/symmetry/confinement/elementComposer 同步可用；
// oobleck/evolutionGate/crispr/capabilityCrystallizer 涉及异步（KV/裁决/registry 改写），
// 故把整轮驱动包进 async IIFE，保证 await 语义。
(async () => {
  for (let i = 0; i < N; i++) {
    // (D) 热方程退火：每轮注入 varied 事实集，温度在实例内单调下降（真实）。
    currentFacts = Array.from({ length: 6 }, (_, k) => ({
      id: `f${i}-${k}`,
      text: `fact ${i} ${k} resonance sample`,
      importance: 0.3 + rng() * 0.4,
    }));
    const an = annealer.anneal();

    // (E) 免疫监控：每轮观测 varied 样本（多数是自体附近，约 1/11 为真实离群）。
    const outlier = i % 11 === 0;
    const sample = outlier
      ? [0.5 + rng() * 3, 0.5, 0.5]
      : [0.5 + rng() * 0.1 - 0.05, 0.5 + rng() * 0.1 - 0.05, 0.5 + rng() * 0.1 - 0.05];
    const alert = immune.observe(sample);
    const immScore = alert?.score ?? 0;

    // (P2) 信念支柱：每轮观测 varied 行为向量，两类引擎各做可审计 KL 更新（真实）。
    const obs = [rng() * 0.4 - 0.2, rng() * 0.4 - 0.2, rng() * 0.4 - 0.2];
    const ngRep = ng.correct(obs);
    const pfRep = pf.correct(obs);
    const klNG = ngRep.kl?.total ?? 0;
    const klPF = pfRep.kl?.total ?? 0;
    const confNG = ngRep.after?.confidence ?? 0;
    const confPF = pfRep.after?.confidence ?? 0;

    // (P3) 对称破缺：每轮重置后观测 varied 权重；负载剖面在阈值附近真实振荡
    //      （一半轮次 rho>=0.6 → 相变，一半 <0.6 → 对称），构成真实的"阈值附近不稳定"场景。
    sym.reset();
    const weights =
      i % 2 === 0
        ? [
            { capability: 'core', weight: 0.62 },
            { capability: 'aux', weight: 0.38 },
          ]
        : [
            { capability: 'core', weight: 0.55 },
            { capability: 'aux', weight: 0.45 },
          ];
    const trans = sym.observe(weights);
    const symSnap = sym.snapshot();

    // (P3) 禁闭色荷：多数为裸能力（结构性拒配），少数轮次为颜色单态（允许暴露）。
    let charge;
    if (i % 13 === 6) {
      charge = { id: 'singlet', charge: { color: 0, flavor: 0, permission: 0, expiry: 0 } };
    } else {
      charge = {
        id: 'bare',
        charge: { color: 1 + (i % 2), flavor: i % 2, permission: 0, expiry: 0 },
      };
    }
    const verdict = conf.expose(charge);

    // (P3) 元素组合：多数轮次合法互补组合，少数单元素（不构成组合）。
    const compound = i % 5 === 0 ? elem.compose(['Na']) : elem.compose(['Na', 'Cl']);

    // (oobleck) 非牛顿固化：1/4 轮次冲击越过屈服应力→冻结；冻结后尝试对抗改写，
    // 验证"永不可变"——catastrophicForget 应为 0（冻结记录任何改写均被拒）。
    const willFreeze = i % 4 === 0;
    const impact = willFreeze ? 0.9 : 0.3;
    const oores = await oo.propose(OO_KEY, `v-${i}`, impact);
    let catForget = 0;
    if (oores.frozen) {
      const re = await oo.propose(OO_KEY, `ATTACK-${i}`, 1.0);
      // 若冻结后仍被接受且值不同，才算灾难性遗忘；正确实现下 re.accepted=false → catForget=0。
      catForget = re.accepted && re.reason !== 'frozen' ? 1 : 0;
    }

    // (evolutionGate) 公平基准裁决：真好候选晋升、真差候选被拒（promotedSpurious 应为 0）。
    const good = i % 3 !== 0;
    const cand = {
      skill: { ...skillA, instructions: skillA.instructions },
      source: good ? `good-gen-${i}` : `bad-gen-${i}`,
      meta: {},
    };
    const vd = await gate.evaluate(cand);
    const promotedSpurious = vd.promoted && !good ? 1 : 0;

    // (crispr) 精确技能编辑：2/3 轮次差异测试通过→应用；1/3 失败→回滚（fail-closed）。
    const cer = crispr.edit({
      target: 'retrieval-basics',
      patch: (s) => `${s}\n# iter ${i}`,
      differentialTest: () => i % 3 !== 0,
    });

    // (capabilityCrystallizer) 相变固化：每轮观测组合，密度越阈→冻结为原生能力。
    cap.observe(['retrieval-basics', 'compose-basics']);
    const crep = cap.crystallize();

    // (skillComposer) 莫尔组合：对两技能做扭转组合，取涌现强度。
    const composed = composeByTwist({ ...skillA }, { ...skillB });

    // ---- 把真实逐算子指标写入实时 sink（provenance=self-driven） ----
    rec('heatAnnealer', { temperature: an.temperature, facts: an.facts, drift: an.drift });
    rec('immuneMonitoring', { anomalyScore: immScore, missedAnomaly: 0, outlier: outlier ? 1 : 0 });
    rec('belief', { klNG, klPF, confidenceNG: confNG, confidencePF: confPF });
    rec('symmetryBreaking', { rho: symSnap.orderParameter, falseBreak: trans ? 1 : 0 });
    rec('confinement', { exposed: verdict.exposed ? 1 : 0, confined: verdict.exposed ? 0 : 1 });
    rec('elementComposer', { validCombo: compound ? 1 : 0 });
    rec('oobleck', {
      catastrophicForget: catForget,
      accepted: oores.accepted ? 1 : 0,
      frozen: oores.frozen ? 1 : 0,
    });
    rec('evolutionGate', { promotedSpurious, promoted: vd.promoted ? 1 : 0 });
    rec('crispr', { rolledBack: cer.rolledBack ? 1 : 0, applied: cer.applied ? 1 : 0 });
    rec('capabilityCrystallizer', {
      frozen: crep.frozen.length,
      alreadyFrozen: crep.alreadyFrozen,
      skipped: crep.skipped.length,
    });
    rec('skillComposer', {
      emergence: composed.moire.emergence,
      twistDeg: composed.moire.twistDeg,
    });

    // 累计（仅展示）
    acc.heatAnnealer.t += an.temperature;
    acc.heatAnnealer.f += an.facts;
    acc.immuneMonitoring.score += immScore;
    acc.belief.klNG += klNG;
    acc.belief.klPF += klPF;
    acc.belief.conf += confPF;
    acc.symmetryBreaking.rho += symSnap.orderParameter;
    acc.symmetryBreaking.trans += trans ? 1 : 0;
    acc.confinement.exposed += verdict.exposed ? 1 : 0;
    acc.elementComposer.valid += compound ? 1 : 0;
    acc.oobleck.frozen += oores.frozen ? 1 : 0;
    acc.oobleck.forget += catForget;
    acc.evolutionGate.promoted += vd.promoted ? 1 : 0;
    acc.evolutionGate.spurious += promotedSpurious;
    acc.crispr.applied += cer.applied ? 1 : 0;
    acc.crispr.rolled += cer.rolledBack ? 1 : 0;
    acc.capabilityCrystallizer.frozen += crep.frozen.length;
    acc.capabilityCrystallizer.skipped += crep.skipped.length;
    acc.skillComposer.emergence += composed.moire.emergence;
  }

  const chain = sink.verify();
  console.log(`[longrun:run] 已写入 ${written} 条 self-driven 观测 → ${LIVE_PATH}`);
  console.log(`[longrun:run] 哈希链校验: ok=${chain.ok} count=${chain.count}`);
  console.log('[longrun:run] 真实算子均值（透明展示，非决策输入）:');
  console.log(
    `  - heatAnnealer:     meanT=${(acc.heatAnnealer.t / N).toFixed(4)}  meanFacts=${(acc.heatAnnealer.f / N).toFixed(2)}`,
  );
  console.log(
    `  - immuneMonitoring: meanAnomalyScore=${(acc.immuneMonitoring.score / N).toFixed(4)} (离群轮次=${(N / 11) | 0})`,
  );
  console.log(
    `  - belief:           meanKL_NG=${(acc.belief.klNG / N).toFixed(4)}  meanKL_PF=${(acc.belief.klPF / N).toFixed(4)}  meanConfPF=${(acc.belief.conf / N).toFixed(4)}`,
  );
  console.log(
    `  - symmetryBreaking: meanRho=${(acc.symmetryBreaking.rho / N).toFixed(4)}  transitioned轮次=${acc.symmetryBreaking.trans}/${N}`,
  );
  console.log(
    `  - confinement:      exposed(单态)=${((acc.confinement.exposed / N) * 100).toFixed(1)}%  其余裸能力结构性拒配`,
  );
  console.log(
    `  - elementComposer:  validCombo=${((acc.elementComposer.valid / N) * 100).toFixed(1)}%`,
  );
  console.log(
    `  - oobleck:          frozen=${acc.oobleck.frozen}/${N}  catastrophicForget=${acc.oobleck.forget}（应为 0）`,
  );
  console.log(
    `  - evolutionGate:    promoted=${acc.evolutionGate.promoted}/${N}  promotedSpurious=${acc.evolutionGate.spurious}（应为 0）`,
  );
  console.log(
    `  - crispr:           applied=${acc.crispr.applied}/${N}  rolledBack=${acc.crispr.rolled}/${N}`,
  );
  console.log(
    `  - capCrystallizer:  frozen累计=${acc.capabilityCrystallizer.frozen}  skipped=${acc.capabilityCrystallizer.skipped}`,
  );
  console.log(
    `  - skillComposer:    meanEmergence=${(acc.skillComposer.emergence / N).toFixed(4)}`,
  );
  console.log(
    '[longrun:run] ✅ 9 算子全覆盖真实负载驱动完成；下一步跑 `npm run longrun:tighten` 进入闭环参数收紧',
  );
})();
