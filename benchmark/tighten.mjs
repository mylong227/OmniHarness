// tighten.mjs —— I-P4-3 闭环参数收紧分析器
//
// 设计铁律（诚实边界）：
//   1. 收紧决策【只认真实运行观测】—— provenance 为 'production'（外部真实负载经
//      SparkController 落盘）或 'self-driven'（用同源真实引擎自驱负载，见 longrun_run.mjs）。
//      seed-bootstrap / synthetic-lab 数据【绝不】参与收紧——否则就是把"已有证据"当"真实负载"调参。
//   2. 收紧方向【只能更严、不能更松】：任何可调参数只可向 floor 之上收紧，绝不降到当前基线以下（fail-closed 不退化）。
//   3. 结构性安全参数（RSI 红线、零依赖铁律、confinement 群阶 SU(3)）属 LOCKED，数据不可调，仅人工拍板。
//   4. 样本不足（< MIN_N）一律 INSUFFICIENT_DATA，保持当前参数，不伪造收紧结论。
//
// 用法：npm run longrun:tighten   （会先 build；可选参数 --live <path> 指定真实 sink）

import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JsonlRuntimeTelemetry } from '../dist/src/adapters/telemetry/jsonlRuntimeTelemetry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 支持 --live <path> 或 --live=<path> 指定真实 sink（如生产路径产出的 runtime-telemetry.prod.log）；
// 相对路径按本脚本所在目录解析，缺省用自驱负载文件 runtime-telemetry.log。
let liveRaw;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--live' && i + 1 < process.argv.length) {
    liveRaw = process.argv[i + 1];
    break;
  }
  if (process.argv[i].startsWith('--live=')) {
    liveRaw = process.argv[i].slice('--live='.length);
    break;
  }
}
const LIVE_PATH = liveRaw
  ? liveRaw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(liveRaw)
    ? liveRaw
    : join(__dirname, liveRaw)
  : join(__dirname, 'runtime-telemetry.log');
const SEED_PATH = join(__dirname, 'runtime-telemetry.seed.log');
const OUT_PATH = LIVE_PATH.replace(/\.log$/, '.tighten.json');

/** 最小 production 样本量，低于此不收紧（防小样本幻觉）。 */
const MIN_N = 30;

/** LOCKED：结构性安全参数，数据不可调，仅人工拍板。 */
const LOCKED = [
  { param: 'RSI 红线', note: '看板锁定 ON：禁止改自身训练/复制/自授权（严禁 OFF）' },
  {
    param: '依赖准入门禁',
    note: '看板锁定 ON：引入外部依赖须经 dependency-allowlist.json 登记 + check.mjs 四闸门准入（严禁 OFF）',
  },
  { param: 'confinement.groupOrder', note: '结构性 SU(3) 代数，非数据可调；改动即改拒配代数' },
];

/** 数值平均（缺字段按 0，不伪造）。 */
function mean(metrics, field) {
  if (metrics.length === 0) return 0;
  const sum = metrics.reduce((a, m) => a + (Number(m[field]) || 0), 0);
  return sum / metrics.length;
}
/** 满足谓词的比例（缺字段按 0，不伪造）。 */
function rate(metrics, pred) {
  if (metrics.length === 0) return 0;
  return metrics.filter(pred).length / metrics.length;
}
/** 标准差（衡量稳定性；缺字段按 0，不伪造）。 */
function stddev(metrics, field) {
  if (metrics.length < 2) return 0;
  const m = mean(metrics, field);
  const v = metrics.reduce((a, x) => a + ((Number(x[field]) || 0) - m) ** 2, 0) / metrics.length;
  return Math.sqrt(v);
}

/**
 * 可调参数表：floor = 安全地板（= 当前基线，绝不降到其下）；ceil = 安全上限（仅更严方向）。
 * kpi(metrics[]) 给出透明证据串；decide(metrics[]) 在样本充足时给出 TIGHTEN/KEEP。
 * 所有 decide 仅可"更严"（向上增大至 ceil），绝不放松到 floor 之下（fail-closed 不退化）。
 */
const TUNABLE = [
  {
    operator: 'oobleck',
    param: 'yieldStress',
    floor: 0.6,
    ceil: 0.95,
    current: 0.6,
    kpi: (m) => `catastrophicForget=${rate(m, (x) => (x.catastrophicForget ?? 0) > 0).toFixed(3)}`,
    decide: (m) => (rate(m, (x) => (x.catastrophicForget ?? 0) > 0) > 0.02 ? 'TIGHTEN' : 'KEEP'),
  },
  {
    operator: 'evolutionGate',
    param: 'minGain',
    floor: 0.05,
    ceil: 0.5,
    current: 0.05,
    kpi: (m) => `promotedSpurious=${rate(m, (x) => (x.promotedSpurious ?? 0) > 0).toFixed(3)}`,
    decide: (m) => (rate(m, (x) => (x.promotedSpurious ?? 0) > 0) > 0.02 ? 'TIGHTEN' : 'KEEP'),
  },
  {
    operator: 'symmetryBreaking',
    param: 'threshold',
    floor: 0.7,
    ceil: 0.95,
    current: 0.7,
    // 证据：self-driven 注入已知对称/破缺态 → falseBreak；production 无标注 → 用 rho 近【当前阈值】摆动代理不稳定。
    // 注意：触发锚点必须与 current 同步（本次 0.70）；若后续再收紧须同步上移，否则闭环永远对旧锚点报 TIGHTEN。
    kpi: (m) =>
      `instability=${rate(m, (x) => (x.falseBreak ?? 0) > 0 || Math.abs((x.orderParameter ?? x.rho ?? 0) - 0.7) < 0.05).toFixed(3)}`,
    decide: (m) =>
      rate(
        m,
        (x) => (x.falseBreak ?? 0) > 0 || Math.abs((x.orderParameter ?? x.rho ?? 0) - 0.7) < 0.05,
      ) > 0.02
        ? 'TIGHTEN'
        : 'KEEP',
  },
  {
    operator: 'immuneMonitoring',
    param: 'threshold',
    floor: 3,
    ceil: 12,
    current: 3,
    kpi: (m) => `missedAnomaly=${rate(m, (x) => (x.missedAnomaly ?? 0) > 0).toFixed(3)}`,
    decide: (m) => (rate(m, (x) => (x.missedAnomaly ?? 0) > 0) > 0.02 ? 'TIGHTEN' : 'KEEP'),
  },
  {
    operator: 'heatAnnealer',
    param: 'resonanceThreshold',
    floor: 0.6,
    ceil: 0.9,
    current: 0.6,
    // 稳定性信号（非绝对幅度）：退火扰动 stddev 过大 → 退火剧烈不稳定 → 上调阈值使其更保守（仅更严）。
    // 绝对 drift 大只是事实集更替的正常幅度，不算不稳；只有抖动剧烈才收紧。
    kpi: (m) => `driftStd=${stddev(m, 'drift').toFixed(3)} (mean=${mean(m, 'drift').toFixed(3)})`,
    decide: (m) => (stddev(m, 'drift') > 1.5 ? 'TIGHTEN' : 'KEEP'),
  },
  {
    operator: 'belief',
    param: 'particles',
    floor: 200,
    ceil: 600,
    current: 200,
    kpi: (m) => `meanConfPF=${mean(m, 'confidencePF').toFixed(3)}`,
    // 粒子滤波置信（ESS/N）过低 → 信念估计不可靠 → 增加粒子数（仅更严，向上）。
    decide: (m) => (mean(m, 'confidencePF') < 0.5 ? 'TIGHTEN' : 'KEEP'),
  },
  {
    operator: 'crispr',
    param: 'addressThreshold',
    floor: 0.5,
    ceil: 0.95,
    current: 0.5,
    kpi: (m) => {
      const ap = m.reduce((a, x) => a + (x.applied ?? 0), 0);
      const rb = m.reduce((a, x) => a + (x.rolledBack ?? 0), 0);
      const off = ap + rb > 0 ? rb / (ap + rb) : 0;
      return `offTargetRate=${off.toFixed(3)} (applied=${ap},rolledBack=${rb})`;
    },
    // 脱靶率（差异测试失败回滚占比）过高 → 寻址过松、放行差编辑 → 上调寻址阈值（仅更严）。
    decide: (m) => {
      const ap = m.reduce((a, x) => a + (x.applied ?? 0), 0);
      const rb = m.reduce((a, x) => a + (x.rolledBack ?? 0), 0);
      const off = ap + rb > 0 ? rb / (ap + rb) : 0;
      return off > 0.5 ? 'TIGHTEN' : 'KEEP';
    },
  },
  {
    operator: 'capabilityCrystallizer',
    param: 'densityThreshold / emergenceFloor',
    floor: 3,
    ceil: 10,
    current: 3,
    kpi: (m) => {
      // 仅统计真正调用过 composeByTwist 的轮次（emergenceComposed>0），排除已冻结跳过的空轮（emergence=0 假低）。
      const em = m.filter((x) => (x.emergenceComposed ?? 0) > 0).map((x) => x.emergence);
      // EMERGENCE_MIN=10：涌现样本不足则不据此评估（避免单样本幻觉）。
      const me =
        em.length >= 10
          ? (em.reduce((a, b) => a + b, 0) / em.length).toFixed(3) + `(n=${em.length})`
          : `n/a(仅 ${em.length} 样本<10, 不足以评估涌现)`;
      return `meanFrozenPerCycle=${mean(m, 'frozen').toFixed(3)}; meanEmergence=${me}`;
    },
    // 双信号（仅更严）：
    //  (a) 每轮冻结过多（密度未达阈仍固化）→ 固化过激进 → 上调密度阈值。
    //  (b) 莫尔涌现增益过低（组合极少产生高涌现结构）→ 扭转不具生产力 → 上调涌现接纳下限
    //      emergenceFloor（真实接在 composeByTwist，低于下限的组合被固化器拒收）。
    //  注：涌现样本须 ≥10 且来自真组合轮次（emergenceComposed>0）才据此收紧，否则不误判（仅 (a) 生效）。
    decide: (m) => {
      if (mean(m, 'frozen') > 1.0) return 'TIGHTEN';
      const em = m.filter((x) => (x.emergenceComposed ?? 0) > 0).map((x) => x.emergence);
      if (em.length >= 10 && em.reduce((a, b) => a + b, 0) / em.length < 0.3) return 'TIGHTEN';
      return 'KEEP';
    },
  },
];

function main() {
  // 真实 sink（production + self-driven 均属真实运行观测）
  const live = new JsonlRuntimeTelemetry({ path: LIVE_PATH });
  const liveObs = live.read();
  const liveChain = live.verify();
  const production = liveObs.filter(
    (o) => o.provenance === 'production' || o.provenance === 'self-driven',
  );

  // seed（仅用于呈现当前参数面，不参与决策）
  let seedCount = 0;
  if (existsSync(SEED_PATH)) {
    const seed = new JsonlRuntimeTelemetry({ path: SEED_PATH });
    seedCount = seed.read().length;
  }

  const perOperator = {};
  for (const o of production) {
    (perOperator[o.operator] ??= []).push(o);
  }

  const recommendations = [];
  for (const t of TUNABLE) {
    const samples = perOperator[t.operator] ?? [];
    const n = samples.length;
    if (n < MIN_N) {
      recommendations.push({
        operator: t.operator,
        param: t.param,
        current: t.current,
        floor: t.floor,
        ceil: t.ceil,
        evidence: undefined,
        productionN: n,
        status: 'INSUFFICIENT_DATA',
        action: 'KEEP',
        note: `production 样本 ${n} < MIN_N(${MIN_N})，保持当前 ${t.current}；需真实负载累积 ≥ ${MIN_N} 次观测`,
      });
    } else {
      // 样本充足：抽取该算子的可收紧指标（缺字段按 0 处理，不伪造）
      const metrics = samples.map((s) => s.metrics ?? {});
      const decision = t.decide(metrics);
      const evidence = t.kpi ? t.kpi(metrics) : undefined;
      recommendations.push({
        operator: t.operator,
        param: t.param,
        current: t.current,
        floor: t.floor,
        ceil: t.ceil,
        evidence,
        productionN: n,
        status: 'EVALUATED',
        action: decision === 'TIGHTEN' ? 'TIGHTEN' : 'KEEP',
        note:
          decision === 'TIGHTEN'
            ? `证据触发收紧：${evidence}；仅可向更安全方向（增大）落在 [current, ceil]，绝不降到 floor(${t.floor}) 之下；具体值由运维按证据拍板。`
            : `证据未触发收紧（${evidence}），保持当前 ${t.current}`,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    minN: MIN_N,
    live: {
      path: LIVE_PATH,
      exists: existsSync(LIVE_PATH),
      chainOk: liveChain.ok,
      total: liveObs.length,
      production: production.length,
    },
    seed: { path: SEED_PATH, count: seedCount, note: '仅呈现当前参数面，不参与收紧决策' },
    locked: LOCKED,
    tunable: recommendations,
    summary: {
      totalTunable: TUNABLE.length,
      tightened: recommendations.filter((r) => r.action === 'TIGHTEN').length,
      kept: recommendations.filter((r) => r.action === 'KEEP').length,
      insufficient: recommendations.filter((r) => r.status === 'INSUFFICIENT_DATA').length,
      locked: LOCKED.length,
    },
    honestBoundary:
      production.length === 0
        ? '当前无任何真实运行观测（production 或 self-driven）。收紧算法只认真实运行观测，故全部参数保持基线。闭环已就位，待 runtimeTelemetry 累积真实观测后自动评估。'
        : '仅基于真实运行观测（production/self-driven），seed-bootstrap（文献派生）已排除。',
  };

  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

  // 控制台渲染
  console.log('=== I-P4-3 参数收紧闭环分析 ===');
  console.log(
    `live sink: ${LIVE_PATH} (exists=${report.live.exists}, chainOk=${report.live.chainOk})`,
  );
  console.log(
    `真实运行观测(production+self-driven): ${production.length} 条；seed 证据: ${seedCount} 条（不参与决策）`,
  );
  console.log(`\n[LOCKED · 人工拍板，数据不可调]`);
  for (const l of LOCKED) console.log(`  - ${l.param}: ${l.note}`);
  console.log(`\n[TUNABLE · 仅更严不更松，floor=[当前,ceil]]`);
  for (const r of recommendations) {
    console.log(
      `  - ${r.operator}.${r.param}: ${r.action} (当前 ${r.current}, floor ${r.floor}, ceil ${r.ceil}, n=${r.productionN}) [${r.status}] 证据=${r.evidence ?? '-'}`,
    );
  }
  console.log(
    `\n汇总: 收紧 ${report.summary.tightened} / 保持 ${report.summary.kept} / 不足 ${report.summary.insufficient} / 锁定 ${report.summary.locked}`,
  );
  console.log(`诚实边界: ${report.honestBoundary}`);
  console.log(`\n报告已写 ${OUT_PATH}`);
}

main();
