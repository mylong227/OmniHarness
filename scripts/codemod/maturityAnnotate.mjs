#!/usr/bin/env node
// 隐喻引擎成熟度标注器（codemod，幂等）。
//
// 背景（T0 · 成熟度治理，见 docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md）：
//   本仓库有 20+ 个以物理/生物/化学命名的引擎（退火、免疫、涡环、QEC、结晶、对称破缺…）。
//   命名不等于机制。治理的第一步是**把等级写进代码**，让「声称」可被机械校验。
//
// 契约（由 scripts/auditStandards.mjs --maturity 校验）：
//   @maturity L0|L1|L2|L3 — <一句话判据>
//   @maturityEvidence <测试文件路径>      // L2/L3 必填，且文件必须存在
//
// 等级定义（docs/library/README.md 铁律二）：
//   L0 命名级    只有名字像，算法是普通启发式；换名不影响行为
//   L1 结构同构  数据结构/组合律与理论对象同构，可等式推理
//   L2 动力学同构 演化规则与理论方程同构（同一差分/微分形式）
//   L3 可证性质  理论中的定理在本实现里被单测机械证明
//
// 用法：
//   node scripts/codemod/maturityAnnotate.mjs          # dry-run，只打印将要改动的文件
//   node scripts/codemod/maturityAnnotate.mjs --apply  # 落盘
//
// 幂等：已含 @maturity 声明的文件会被**更新**而非重复插入；未登记的文件不受影响。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPLY = process.argv.includes('--apply');

/**
 * 成熟度登记册：文件路径 → [等级, 判据, 证据测试]。
 * 等级来自 docs/library/README.md §4 全局映射总表的实测结论，不是目标值。
 */
const REGISTRY = [
  [
    'src/genesis/algebra.ts',
    'L3',
    '结合律/单位元/交换律有单测，可组合推演',
    'tests/unit/genesis.test.ts',
  ],
  [
    'src/genesis/modalityPort.ts',
    'L3',
    'Modality.map 的恒等律与组合律有单测',
    'tests/unit/genesis.test.ts',
  ],
  [
    'src/genesis/operator.ts',
    'L3',
    'composeOperator 组合律与 identityOperator 有单测',
    'tests/unit/genesis.test.ts',
  ],
  [
    'src/genesis/ledger.ts',
    'L3',
    'record/commit 闭合可机械检出；记账不变量，非物理守恒',
    'tests/unit/genesis.test.ts',
  ],
  [
    'src/genesis/regime.ts',
    'L3',
    '单调收缩⇒不动点，收敛性有单测（全库最强理论兑现）',
    'tests/unit/genesis.test.ts',
  ],
  [
    'src/adapters/memory/heatEquationAnnealer.ts',
    'L2',
    '真做扩散步；冷却调度的最优性未证',
    'tests/unit/heatAnnealer.test.ts',
  ],
  [
    'src/adapters/belief/particleFilterBelief.ts',
    'L2',
    '序贯重要性重采样；有效样本数与退化处理决定成败',
    'tests/unit/particleFilter.test.ts',
  ],
  [
    'src/adapters/belief/naturalGradientBelief.ts',
    'L2',
    '用自然梯度方向；流形假设未验证（待复核，或应降 L1）',
    'tests/unit/naturalGradient.test.ts',
  ],
  [
    'src/context/lsaEngine.ts',
    'L1',
    '截断 SVD 存在；实测叠加有害（Eckart–Young 是重构最优≠排序保序）',
    'tests/unit/lsaRecall.test.ts',
  ],
  [
    'src/context/codeReferenceGraph.ts',
    'L1',
    '幂迭代存在；44 万边实测零增益（谱隙→0 时收敛到均匀分布）',
    'tests/unit/codeReferenceGraph.test.ts',
  ],
  [
    'src/search/bm25Index.ts',
    'L1',
    '主力召回；形态归并已破一层天花板（实测文件召回 67.0%）',
    'tests/unit/toolSearch.test.ts',
  ],
  [
    'src/evolution/verifiableReward.ts',
    'L1',
    '可验证奖励结构在；势函数覆盖率未知（T5 待体检）',
    'tests/unit/rlvr.test.ts',
  ],
  [
    'src/evolution/rlvrController.ts',
    'L1',
    'RLVR 闭环在；Echo Trap 防护未证',
    'tests/unit/evolutionRlvr.test.ts',
  ],
  [
    'src/evolution/evolutionControllerImpl.ts',
    'L1',
    '进化闭环在；适应度地形（NK）假设未验证',
    'tests/unit/evolutionIntegration.test.ts',
  ],
  [
    'src/evolution/twistDiscoveryEngine.ts',
    'L1',
    '失败模式挖掘在；是否真产出被门禁采纳的改进未量化',
    'tests/unit/discoveryEngine.test.ts',
  ],
  [
    'src/eval/passK.ts',
    'L1',
    'Pass@k + 确定性 bootstrap 95% CI（消随机红/绿）；「≥5 次跑」规范化待补',
    'tests/unit/passK.test.ts',
  ],
  [
    'src/adapters/monitoring/immuneMonitor.ts',
    'L0',
    '框架在；未与 prompt injection 对抗集（AgentDojo/InjecAgent）接通',
    'tests/unit/immuneMonitor.test.ts',
  ],
  [
    'src/adapters/skill/capabilityCrystallizer.ts',
    'L0',
    '「结晶」目前是阈值固化，非成核动力学',
    'tests/unit/capabilityCrystallizer.test.ts',
  ],
  [
    'src/adapters/monitoring/symmetryBreakingEngine.ts',
    'L0',
    '命名级；未定义序参量，无自发破缺动力学',
    'tests/unit/symmetryBreaking.test.ts',
  ],
  [
    'src/adapters/spill/vortexRingPacket.ts',
    'L0',
    '打包语义，非拓扑不变量（拓扑荷只是可算代理）',
    'tests/unit/vortexRing.test.ts',
  ],
  [
    'src/adapters/memory/qecEncoder.ts',
    'L0',
    '用冗余/校验思想；非量子，宜称「轨迹级校验关系 + 显式冗余」',
    'tests/unit/qec.test.ts',
  ],
  [
    'src/adapters/memory/cosmicWebMemoryEngine.ts',
    'L0',
    '邻接连通在；Kuramoto 同步动力学未实现',
    'tests/unit/cosmicWeb.test.ts',
  ],
  [
    'src/adapters/memory/resonantFieldEngine.ts',
    'L0',
    '场强叠加在；与词袋冗余（实测零增益）',
    'tests/unit/resonantField.test.ts',
  ],
  [
    'src/adapters/skill/crisprSkillEditor.ts',
    'L0',
    '技能改写；非基因编辑',
    'tests/unit/crispr.test.ts',
  ],
];

/** 在源码里已有 @maturity 声明时，就地更新等级行与证据行。 */
function replaceExisting(text, level, note, evidence) {
  const lines = text.split('\n');
  let touched = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\*\s*@maturity\s+L[0-3]/.test(lines[i])) {
      lines[i] = ` * @maturity ${level} — ${note}`;
      touched++;
    } else if (/^\s*\*\s*@maturityEvidence\s/.test(lines[i])) {
      lines[i] = ` * @maturityEvidence ${evidence}`;
      touched++;
    }
  }
  return touched > 0 ? lines.join('\n') : null;
}

/** 在顶部 JSDoc 块（或文件首部新建块）写入成熟度声明。 */
function insertDeclaration(text, level, note, evidence) {
  const block = [
    '/**',
    ` * @maturity ${level} — ${note}`,
    ` * @maturityEvidence ${evidence}`,
    ' */',
  ].join('\n');

  // 判定「顶部 JSDoc」：跳过前导空行与 shebang 后，首个非空内容以 /** 开头。
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#!'))) i++;
  if (i < lines.length && lines[i].trim().startsWith('/**')) {
    for (let j = i; j < lines.length; j++) {
      if (lines[j].includes('*/')) {
        // 在该块结束前插入，保持原块内容完整（前置空注释行分隔正文与标签）。
        lines.splice(
          j,
          0,
          ' *',
          ` * @maturity ${level} — ${note}`,
          ` * @maturityEvidence ${evidence}`,
        );
        return lines.join('\n');
      }
    }
  }
  // 无顶部 JSDoc：在文件最前面新建块（文件级注释）。
  return block + '\n' + text;
}

let changed = 0;
let skipped = 0;
const problems = [];

for (const [rel, level, note, evidence] of REGISTRY) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    problems.push(`源文件缺失：${rel}`);
    continue;
  }
  if (!existsSync(join(ROOT, evidence))) {
    problems.push(`证据文件缺失：${evidence}（登记于 ${rel}）`);
  }
  const before = readFileSync(abs, 'utf8');
  const updated =
    replaceExisting(before, level, note, evidence) ??
    insertDeclaration(before, level, note, evidence);
  if (updated === before) {
    skipped++;
    continue;
  }
  if (APPLY) writeFileSync(abs, updated, 'utf8');
  changed++;
  console.log(`${APPLY ? 'WRITE' : 'DRY  '} ${level}  ${rel}`);
}

console.log(
  `\n合计：登记 ${REGISTRY.length} 项，${APPLY ? '已写入' : '待写入'} ${changed}，无变化 ${skipped}。`,
);
if (problems.length > 0) {
  console.error('\n❌ 登记册自身有问题（未改动任何文件）：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
if (!APPLY && changed > 0) console.log('\n提示：确认无误后加 --apply 落盘。');
