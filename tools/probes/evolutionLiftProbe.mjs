#!/usr/bin/env node
/**
 * 进化增益自证探针（商业化路线图 **E2+**，2026-10-04；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * 「进化闭环（twist 重组 → 门禁评估 → 晋升落表）相对**固定技能集**，到底有没有增益？」
 * 商业化报告 E2 的原话是：**增益从未量化；探针跑不出数字不得声称完成；不显著 ⇒ 进化保持默认关并如实登记**。
 * 本探针就是那个"能跑出数字"的东西。
 *
 * ## 口径：**机制级**，不是 LLM 任务成功率（本探针最重要的边界）
 *
 * 离线免模型时，任何"进化开/关的任务成功率 A/B"都只能测到我自己写的假打分脚本。故本探针量的是**机制**：
 *
 * - **任务/工况**：M 个**工况桶**，每个桶有一个目标能力场（平面波：频率 × 取向，由固定种子派生）；
 * - **技能**：每个技能有真实能力场（`MoireComposer.capabilityFieldOf`，缺省由技能文本确定性派生）；
 * - **桶适配度** `fit(skill, bucket)`：技能场与目标场的归一化相关（均值去除后内积）——**该工况下这个技能有多对**；
 * - **臂成绩** `outcome(arm, bucket) = max over 臂内技能 of fit(skill, bucket)`——"这套技能集能给到的最好匹配"；
 * - **演化算子**：真实 `MoireComposer.composeByTwist(a, b)`（生产同款转角组合，产出"两片都没有"的涌现长波）；
 * - **门禁分数**：真实 `SkillSchema.benchmarkOf(skill)`（＝`Benchmark.moireEnergy(skill, 64)`，与 ring ④ 门禁、
 *   ring ⑥ CRISPR 差分**同一把尺子**）。
 *
 * **它不能证明**「进化让模型任务更成功」——那需要真实模型与真实任务集。它回答的是：
 * "**重组 + 门禁晋升这套机制，能否在留出工况上稳定提升覆盖**"。
 *
 * ## 两关统计（与 `memoryLiftProbe.mjs` 同口径）
 *
 * 任务级**配对**差值 → ① 配对 bootstrap 95% CI **不跨 0**；② repeated 2-fold 留出折**同向（折负 0）**。
 * 两关全过才算 `gain`；否则 `not-significant`（**这是结论，不是失败**）。
 *
 * ## E2+ 纪律闸：val/test 分离（结构性拒绝"测试集参与选型"）
 *
 * - **选型只看 val 桶**：候选晋升（组合哪两个父技能、接受哪个候选）只依据 val 桶的成绩；
 * - **test 桶只在终判使用一次**：两关统计全部在 test 桶上算；
 * - **违规即拒**：选型函数收到 test 桶索引会**抛错并 exit 4**——不是"提醒你别这么用"，是**拒绝执行**。
 *
 * ## 判死能力自证（本探针的灵魂）
 *
 * 判据只会说好话就没有价值。故内置**结构性零对照**：同数量晋升，但候选＝父技能**原样副本**（无组合）
 * ⇒ 增益必须是 0（CI 跨 0、折含负）。若零对照也报出增益，说明**判据会凭空造增益** ⇒
 * 输出 `judgeDiscriminates: false` 并以退出码 3 提示。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`（本探针 import `dist/src/**`）。缺产物 ⇒ 退出码 2。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/evolutionLiftProbe.mjs [--buckets=48] [--rounds=3] [--json=out.json]
 * ```
 *
 * 退出码：`0` 报告已出（gain / not-significant 都算成功交付）｜`2` 缺编译产物｜`3` 判据无区分力｜`4` 纪律违规。
 *
 * ## 诚实边界
 *
 * - 工况桶与种子技能是**探针自建夹具**（平面波族），不代表真实工况分布；数字只用于**同夹具内**的开/关对照；
 * - 适配度是"场相关"这种机械量，不是语义相关；门禁分数用的是本仓既有标尺（非外部基准）；
 * - **未测**：真实模型上的任务成功率、真实遥测驱动的候选分布、晋升后的生产检索行为（后者由单测 J4/J6 覆盖）。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

/**
 * 读命令行 `--name=value`。
 * @param {string} name 参数名（不含 `--`）。
 * @param {string} dflt 缺省值。
 * @returns {string} 值。
 */
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

let MoireComposer;
let SkillSchema;
try {
  ({ MoireComposer } = await importDist('skill', 'moireComposer.js'));
  ({ SkillSchema } = await importDist('capability', 'schemas', 'skillSchema.js'));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

/** 能力场边长（与 `SkillSchema.benchmarkOf` 的 64 不同：本探针只需 16×16 即可分辨频率/取向）。 */
const N = 16;
/** 固定种子（可复现的根）。 */
const SEED = 20261004;
/** val 桶占比（其余为 test）。 */
const VAL_RATIO = 0.6;
/** 晋升门禁：门禁分数下限（真实标尺的取值范围内的保守阈值）。 */
const GATE_MIN_ENERGY = Number(arg('gate', '0.02'));
/** 桶增益阈值（**预注册**）：候选必须把该桶的 val 适配度提升这么多才被接受。 */
const LIFT_EPS = Number(arg('lift', '0.01'));
/** 敏感性分析用的临时覆盖（undefined = 用预注册值）；**不是**生产配置。 */
let LIFT_EPS_OVERRIDE;

const BUCKETS = Number(arg('buckets', '48'));
const ROUNDS = Number(arg('rounds', '3'));
const SEED_SKILLS = Number(arg('skills', '16'));
const JSON_OUT = arg('json', '');

/**
 * mulberry32：确定性 PRNG（探针禁用 `Math.random`——那会让数字不可复现）。
 * @param {number} seed 种子。
 * @returns {() => number} [0,1) 上的确定性序列。
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 造一个平面波能力场（值 ∈ [-1,1] 的 N×N 正弦光栅）。
 * @param {number} freq 空间频率。
 * @param {number} theta 取向（弧度）。
 * @returns {number[]} 扁平场。
 */
function planeField(freq, theta) {
  const field = new Array(N * N).fill(0);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const u = x * Math.cos(theta) + y * Math.sin(theta);
      field[y * N + x] = Math.sin((2 * Math.PI * freq * u) / N);
    }
  }
  return field;
}

/**
 * 造一个**拍频（莫尔）场**：两片平面波的**逐点乘积**——这正是"两片都没有"的形态，
 * 也是 `MoireComposer.composeByTwist` 在涌现峰值处取的那种场。
 *
 * **为什么夹具必须包含这一族目标**（探针第一版就是漏了它）：目标若全是单片平面波，
 * 那么"取最好的两个父技能再组合"几乎不可能比最好的那个父更好 ⇒ 门禁一个都不晋升
 * ⇒ ON 臂与 OFF 臂**逐位相同**，配对差值恒 0——探针看起来"跑通了"，**实际什么都没测**。
 * 含拍频目标后，机制才有可发挥的空间。**注意这使夹具对机制"友好"**：此处报出增益只说明
 * "目标族与该算子匹配时机制有效"，**不能**外推为"生产进化有增益"（见头注释的诚实边界）。
 * @param {number} f1 第一片频率。
 * @param {number} t1 第一片取向。
 * @param {number} f2 第二片频率。
 * @param {number} t2 第二片取向。
 * @returns {number[]} 扁平场（乘积后归一化到 [-1,1]）。
 */
function beatField(f1, t1, f2, t2) {
  const a = planeField(f1, t1);
  const b = planeField(f2, t2);
  const out = new Array(N * N).fill(0);
  for (let i = 0; i < out.length; i += 1) out[i] = a[i] * b[i];
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  return peak === 0 ? out : out.map((v) => v / peak);
}

/**
 * 归一化相关（各自去均值后内积 / 模长积）——"这个技能场与目标场有多对"。
 * @param {readonly number[]} a 场 A。
 * @param {readonly number[]} b 场 B。
 * @returns {number} [-1,1]。
 */
function correlate(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/**
 * 把技能场取成扁平数组（缺省由组合器按技能文本确定性派生）。
 * @param {object} skill 技能。
 * @returns {number[]} 扁平场。
 */
function fieldOf(skill) {
  return MoireComposer.capabilityFieldOf(skill, N).flat();
}

/**
 * 配对 bootstrap 95% CI（固定种子；与 `memoryLiftProbe.mjs` 同口径）。
 * @param {readonly number[]} delta 逐任务配对差值。
 * @param {number} [iters] 重采样次数。
 * @returns {[number, number]} CI 下界与上界。
 */
function pairedCI(delta, iters = 2000) {
  if (delta.length === 0) return [0, 0];
  const rand = rng(SEED ^ 0x5f3759df);
  const means = [];
  for (let i = 0; i < iters; i += 1) {
    let sum = 0;
    for (let j = 0; j < delta.length; j += 1) {
      sum += delta[Math.floor(rand() * delta.length)];
    }
    means.push(sum / delta.length);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor(0.025 * means.length)];
  const hi = means[Math.floor(0.975 * means.length) - 1];
  return [lo, hi];
}

/**
 * repeated 2-fold 留出折（固定种子）：每折用一半样本估计效应、在另一半上验证方向。
 * @param {readonly number[]} delta 逐任务配对差值。
 * @param {number} [repeats] 重复次数。
 * @returns {{pos: number, neg: number}} 同向折与反向折计数。
 */
function folds(delta, repeats = 20) {
  if (delta.length < 4) return { pos: 0, neg: 0 };
  const rand = rng(SEED ^ 0x9e3779b9);
  let pos = 0;
  let neg = 0;
  for (let r = 0; r < repeats; r += 1) {
    const idx = delta.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const half = Math.floor(idx.length / 2);
    const holdout = idx.slice(0, half).map((i) => delta[i]);
    const rest = idx.slice(half).map((i) => delta[i]);
    const holdMean = holdout.reduce((s, v) => s + v, 0) / holdout.length;
    const restMean = rest.reduce((s, v) => s + v, 0) / rest.length;
    // 留出折同向：留出集的方向与另一半一致且非零。
    if (holdMean > 0 && restMean > 0) pos += 1;
    else if (holdMean < 0 && restMean < 0) neg += 1;
  }
  return { pos, neg };
}

// ---- 夹具：工况桶与种子技能 ----

const poolRand = rng(SEED ^ 0x51ed270b);
/** 潜在技能池：40 片平面波——不在种子集里的那些，就是"进化要从已有技能重组出来"的东西。 */
const POOL = Array.from({ length: 40 }, (_, i) => {
  const freq = 1 + Math.floor(poolRand() * 5);
  const theta = poolRand() * Math.PI;
  return {
    name: `pool-${String(i)}`,
    description: `池技能 ${String(i)}`,
    instructions: `pool skill ${String(i)}`,
    capabilityField: planeField(freq, theta),
  };
});

const bucketRand = rng(SEED);
/**
 * 工况桶：目标场两族各半。
 *
 * - **单片族**：目标 = 池里某一片平面波（种子技能可能直接覆盖）；
 * - **拍频族**：目标**按生产算子的实际构造方式生成**——`MoireComposer.composeByTwist(池A, 池B)` 的场，
 *   即"两片都没有、只有组合才有"的目标。
 *
 * **为什么必须这么造**（探针前两版都栽在这里）：目标若与算子的构造方式不同构，
 * 「取最好的两个父再组合」几乎不可能赢过最好的那个父 ⇒ 门禁**几乎不晋升**（第一版 87 评估 0 晋升，
 * 第二版改用逐点乘积目标后仅 1 晋升）⇒ ON 与 OFF 逐位相同、配对差值恒 0——探针"跑通了"却**什么都没测**。
 *
 * **代价（诚实边界）**：这样构造的夹具**对机制友好**。此处报出的增益只说明
 * 「目标族与该算子匹配时机制有效」，**不能**外推为"生产遥测上也有增益"（那需要真实模型与任务集）。
 */
const BUCKETS_SPEC = Array.from({ length: BUCKETS }, (_, i) => {
  const isBeat = i % 2 === 1;
  const a = POOL[Math.floor(bucketRand() * POOL.length)];
  if (!isBeat) {
    return { id: `b${String(i)}`, family: 'plane', target: fieldOf(a) };
  }
  const b = POOL[Math.floor(bucketRand() * POOL.length)];
  const composite = MoireComposer.composeByTwist(a, b, { n: N });
  return { id: `b${String(i)}`, family: 'beat', target: fieldOf(composite) };
});

const skillRand = rng(SEED ^ 0x1234567);
/** 种子技能：场由频率/取向派生，文本带唯一名（`capabilityField` 显式给出以便确定性）。 */
const SEED_SKILL_SET = Array.from({ length: SEED_SKILLS }, (_, i) => {
  const freq = 1 + Math.floor(skillRand() * 5);
  const theta = skillRand() * Math.PI;
  return {
    name: `seed-${String(i)}`,
    description: `种子技能 ${String(i)}`,
    instructions: `seed skill ${String(i)}`,
    capabilityField: planeField(freq, theta),
  };
});

// ---- val/test 划分与纪律闸 ----

const splitRand = rng(SEED ^ 0xabcdef);
const shuffled = BUCKETS_SPEC.map((b, i) => i);
for (let i = shuffled.length - 1; i > 0; i -= 1) {
  const j = Math.floor(splitRand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const VAL_COUNT = Math.round(BUCKETS_SPEC.length * VAL_RATIO);
const VAL_INDEX = new Set(shuffled.slice(0, VAL_COUNT));
const TEST_INDEX = new Set(shuffled.slice(VAL_COUNT));

/**
 * **E2+ 纪律闸**：选型只允许读 val 桶；拿到 test 索引即拒绝执行。
 * @param {readonly number[]} indices 本次选型将读取的桶索引。
 * @returns {void}
 * @throws 含 test 索引时抛错（调用方 exit 4）。
 */
function assertSelectionUsesValOnly(indices) {
  const leaked = indices.filter((i) => TEST_INDEX.has(i));
  if (leaked.length > 0) {
    throw new Error(
      `选型读取了 test 桶（${leaked.length} 个：${leaked.slice(0, 5).join(',')}…）——` +
        '测试集参与选型会让"增益"失去意义（E2+ 纪律闸结构性拒绝）',
    );
  }
}

// ---- 臂 ----

/**
 * 计算某技能集在各桶上的适配度（`max over 技能 of fit`）。
 * @param {readonly object[]} skills 技能集。
 * @param {readonly number[]} indices 桶索引。
 * @returns {number[]} 与 indices 同序的适配度。
 */
function outcomesOf(skills, indices) {
  const fields = skills.map((s) => fieldOf(s));
  return indices.map((i) => {
    const target = BUCKETS_SPEC[i].target;
    let best = -1;
    for (const field of fields) best = Math.max(best, correlate(field, target));
    return best;
  });
}

/**
 * 跑一条臂（OFF / ON / CONTROL 共用同一算子，只换"晋升判据"与**选父宽度**）。
 *
 * **选父宽度** `pairsK`：只看最优两个父（1）时晋升率极低（实测 1/87）——瓶颈可能在**选父**而非门禁，
 * 故支持在"该桶 val 成绩最好的前 K 个技能"里枚举两两组合、取 val 上最好的候选。
 * 关键：这一切**只用 val 成绩**（纪律闸在函数开头就断言），故加宽搜索不违反 val/test 分离。
 * @param {'off'|'on'|'control'} mode 臂模式。
 * @param {number} pairsK 选父宽度（1 = 只取最优两个父）。
 * @returns {{skills: object[], evaluated: number, promoted: number, gateScores: number[]}} 终态与计数。
 */
function runArm(mode, pairsK = 1) {
  let skills = [...SEED_SKILL_SET];
  /** 门禁评估过的候选数（与"晋升数"必须分开报——第一版把两者混为一个计数，掩盖了"晋升 0 个"）。 */
  let evaluated = 0;
  /** 实际晋升进技能集的候选数。 */
  let promoted = 0;
  const gateScores = [];
  if (mode === 'off') return { skills, evaluated, promoted, gateScores };

  const valIndices = [...VAL_INDEX];
  assertSelectionUsesValOnly(valIndices); // 结构性：选型只碰 val。

  for (let round = 0; round < ROUNDS; round += 1) {
    const before = outcomesOf(skills, valIndices);
    const next = [...skills];
    for (let vi = 0; vi < valIndices.length; vi += 1) {
      const bucketIndex = valIndices[vi];
      const target = BUCKETS_SPEC[bucketIndex].target;
      // 该桶当前最好的若干技能作为父候选（**只用 val 成绩**；test 桶从不参与）。
      const ranked = skills
        .map((s, si) => ({ si, fit: correlate(fieldOf(s), target) }))
        .sort((a, b) => b.fit - a.fit)
        .slice(0, Math.max(2, pairsK));

      // 枚举父对（pairsK=1 时只有一对，即旧行为）；每对都算一次门禁分。
      let best;
      for (let x = 0; x < ranked.length; x += 1) {
        for (let y = x + 1; y < ranked.length; y += 1) {
          const pa = ranked[x];
          const pb = ranked[y];
          const candidate =
            mode === 'control'
              ? // 结构性零对照：候选＝父技能原样副本（无组合，增益必须为 0）。
                { ...skills[pa.si] }
              : MoireComposer.composeByTwist(skills[pa.si], skills[pb.si], { n: N });
          const gate = SkillSchema.benchmarkOf(candidate);
          const candidateFit = correlate(fieldOf(candidate), target);
          evaluated += 1;
          gateScores.push(gate);
          if (best === undefined || candidateFit > best.fit)
            best = { candidate, fit: candidateFit, gate };
        }
      }
      if (best === undefined) continue;
      if (mode === 'control') {
        next.push(best.candidate); // 零对照：不看门禁、不看增益，同数量晋升。
        promoted += 1;
        continue;
      }
      if (
        best.gate >= GATE_MIN_ENERGY &&
        best.fit >= before[vi] + (LIFT_EPS_OVERRIDE ?? LIFT_EPS)
      ) {
        next.push(best.candidate);
        promoted += 1;
      }
    }
    skills = next;
  }
  return { skills, evaluated, promoted, gateScores };
}

/**
 * 事后**敏感性分析**：同一机制在更松的晋升阈值下表现如何。
 *
 * **纪律**：这只用于**理解机制**（阈值是"离显著有多远"的解释变量），
 * **不得**据此挑一个好看的阈值上报——那就是"测试集参与选型"，与本探针的纪律闸直接冲突。
 * **主判定永远是预注册阈值**（`--lift=`，缺省 0.01）下的那一行。
 * @param {readonly number[]} lifts 待扫的晋升阈值。
 * @returns {object[]} 每个阈值一行诊断。
 */
function sensitivity(lifts) {
  const rows = [];
  for (const lift of lifts) {
    const keep = LIFT_EPS;
    // 用同一个 `runArm`，但阈值临时替换（探针内部量，非生产配置）。
    LIFT_EPS_OVERRIDE = lift;
    const arm = runArm('on');
    const test = outcomesOf(arm.skills, testIndices);
    const delta = test.map((v, i) => v - offTest[i]);
    const ci = pairedCI(delta);
    const f = folds(delta);
    rows.push({
      liftEps: lift,
      promoted: arm.promoted,
      evaluated: arm.evaluated,
      meanDelta: r4(mean(delta)),
      ci95: [r4(ci[0]), r4(ci[1])],
      folds: f,
      gain: ci[0] > 0 && f.neg === 0,
    });
    LIFT_EPS_OVERRIDE = keep;
  }
  return rows;
}

// ---- 跑三条臂 ----

const testIndices = [...TEST_INDEX];
const off = runArm('off');
const on = runArm('on');
const control = runArm('control');

const offTest = outcomesOf(off.skills, testIndices);
const onTest = outcomesOf(on.skills, testIndices);
const controlTest = outcomesOf(control.skills, testIndices);

const deltaOn = onTest.map((v, i) => v - offTest[i]);
const deltaControl = controlTest.map((v, i) => v - offTest[i]);

const ciOn = pairedCI(deltaOn);
const ciControl = pairedCI(deltaControl);
const foldsOn = folds(deltaOn);
const foldsControl = folds(deltaControl);

const gainOn = ciOn[0] > 0 && foldsOn.neg === 0;
const controlAlsoGains = ciControl[0] > 0 && foldsControl.neg === 0;
/** 判据是否有区分力：零对照**不得**报出增益。 */
const judgeDiscriminates = !controlAlsoGains;
const verdict = gainOn ? 'gain' : 'not-significant';

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length);
/** 保留 4 位小数（报告可读，避免长尾噪音）。 */
const r4 = (v) => Number(v.toFixed(4));

const report = {
  probe: 'evolutionLiftProbe',
  seed: SEED,
  fixture: {
    buckets: BUCKETS,
    valBuckets: VAL_COUNT,
    testBuckets: testIndices.length,
    seedSkills: SEED_SKILLS,
    rounds: ROUNDS,
    fieldN: N,
  },
  thresholds: { gateMinEnergy: GATE_MIN_ENERGY, liftEps: LIFT_EPS },
  arms: {
    off: { skills: off.skills.length, meanTestOutcome: r4(mean(offTest)) },
    on: {
      skills: on.skills.length,
      meanTestOutcome: r4(mean(onTest)),
      evaluated: on.evaluated,
      promoted: on.promoted,
      meanGateScore: r4(mean(on.gateScores)),
    },
    control: {
      skills: control.skills.length,
      meanTestOutcome: r4(mean(controlTest)),
      evaluated: control.evaluated,
      promoted: control.promoted,
    },
  },
  on: {
    meanDelta: r4(mean(deltaOn)),
    ci95: [r4(ciOn[0]), r4(ciOn[1])],
    folds: foldsOn,
    gain: gainOn,
  },
  control: {
    meanDelta: r4(mean(deltaControl)),
    ci95: [r4(ciControl[0]), r4(ciControl[1])],
    folds: foldsControl,
    gains: controlAlsoGains,
  },
  judgeDiscriminates,
  verdict,
  /** 纪律闸自证：选型函数确实会拒绝 test 索引（下面的调用**必须**抛错）。 */
  disciplineGateHolds: (() => {
    try {
      assertSelectionUsesValOnly([...testIndices].slice(0, 1));
      return false;
    } catch {
      return true;
    }
  })(),
  /** 终判口径声明：两关统计只在 test 桶上算（选型从不读它们）。 */
  evaluationSplit: 'selection=val / verdict=test',
};

report.sensitivity = sensitivity([0.02, 0.01, 0.005, 0]);

/**
 * 诊断臂：**选父宽度**（瓶颈定位）。
 *
 * 敏感性分析显示阈值放到最松也只有 1/87 晋升 ⇒ 瓶颈不在门禁，而在"每桶只取最优两个父"这个**搜索宽度**。
 * 本表在预注册阈值下把前 K 个技能两两组合（仍**只用 val** 选），看晋升数与 test 增益如何随 K 变化。
 * **同纪律**：这是诊断，不是用来挑参数上报的（挑参数=测试集选型）。
 */
function parentWidthDiagnostics(ks) {
  const rows = [];
  for (const k of ks) {
    const arm = runArm('on', k);
    const test = outcomesOf(arm.skills, testIndices);
    const delta = test.map((v, i) => v - offTest[i]);
    const ci = pairedCI(delta);
    const f = folds(delta);
    rows.push({
      pairsK: k,
      evaluated: arm.evaluated,
      promoted: arm.promoted,
      meanDelta: r4(mean(delta)),
      ci95: [r4(ci[0]), r4(ci[1])],
      folds: f,
      gain: ci[0] > 0 && f.neg === 0,
    });
  }
  return rows;
}
report.parentWidth = parentWidthDiagnostics([1, 4]);

if (JSON_OUT !== '') {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

console.log('=== 进化增益探针（E2+ · 机制级 · 离线确定性）===');
console.log(
  `夹具：工况桶 ${String(BUCKETS)}（val ${String(VAL_COUNT)} / test ${String(testIndices.length)}）｜` +
    `种子技能 ${String(SEED_SKILLS)}｜重组轮次 ${String(ROUNDS)}｜场 ${String(N)}×${String(N)}`,
);
console.log(
  `OFF  技能 ${String(off.skills.length)} ｜ test 平均适配 ${String(report.arms.off.meanTestOutcome)}`,
);
console.log(
  `ON   技能 ${String(on.skills.length)}（评估 ${String(on.evaluated)} / 晋升 ${String(on.promoted)}）｜ test 平均适配 ${String(report.arms.on.meanTestOutcome)}` +
    ` ｜ 配对均值 ${String(report.on.meanDelta)} ｜ CI95 [${String(report.on.ci95[0])}, ${String(report.on.ci95[1])}] ｜ 折 +${String(foldsOn.pos)}/-${String(foldsOn.neg)}`,
);
console.log(
  `CTRL 技能 ${String(control.skills.length)}（评估 ${String(control.evaluated)} / 晋升 ${String(control.promoted)}）｜ 配对均值 ${String(report.control.meanDelta)}` +
    ` ｜ CI95 [${String(report.control.ci95[0])}, ${String(report.control.ci95[1])}] ｜ 折 +${String(foldsControl.pos)}/-${String(foldsControl.neg)}`,
);
console.log(
  `纪律闸（选型不读 test）：${report.disciplineGateHolds ? '✓ 生效（拒绝 test 索引）' : '✗ 失效'}`,
);
console.log(`判死能力自证（零对照不得报增益）：${judgeDiscriminates ? '✓' : '✗ 判据会凭空造增益'}`);
console.log(
  `结论（**预注册阈值 lift=${String(LIFT_EPS)}**）：${verdict === 'gain' ? '增益（过两关）' : '不显著（未过两关）'}`,
);
console.log('');
console.log(
  '—— 事后敏感性分析（仅用于理解机制；**不得据此挑阈值上报**，主判定以预注册阈值为准）——',
);
for (const row of report.sensitivity) {
  console.log(
    `  lift=${String(row.liftEps)}  评估 ${String(row.evaluated)} / 晋升 ${String(row.promoted)}` +
      `  配对均值 ${String(row.meanDelta)}  CI95 [${String(row.ci95[0])}, ${String(row.ci95[1])}]` +
      `  折 +${String(row.folds.pos)}/-${String(row.folds.neg)}  => ${row.gain ? 'gain' : 'not-significant'}`,
  );
}
console.log('');
console.log('—— 诊断：选父宽度（瓶颈在搜索还是门禁；同样只用 val）——');
for (const row of report.parentWidth) {
  console.log(
    `  前 ${String(row.pairsK)} 个技能两两组合  评估 ${String(row.evaluated)} / 晋升 ${String(row.promoted)}` +
      `  配对均值 ${String(row.meanDelta)}  CI95 [${String(row.ci95[0])}, ${String(row.ci95[1])}]` +
      `  折 +${String(row.folds.pos)}/-${String(row.folds.neg)}  => ${row.gain ? 'gain' : 'not-significant'}`,
  );
}

if (!judgeDiscriminates) {
  console.error(
    '✗ 判据无区分力：结构性零对照也报出增益。此时**任何**增益数字都不可引用，请先修判据。',
  );
  process.exit(3);
}
if (!report.disciplineGateHolds) {
  console.error('✗ 纪律闸失效：选型可以读到 test 桶。测试集参与选型的结论一律作废。');
  process.exit(4);
}
if (verdict !== 'gain') {
  console.log(
    '→ 按 E2 纪律：**进化保持默认关**，本报告（含负结论）进看板；对外材料不得引用未过两关的增益数字。',
  );
}
