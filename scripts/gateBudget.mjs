#!/usr/bin/env node
/**
 * 门禁**耗时预算**门禁（G27/TS3，2026-10-03 第十六轮）。
 *
 * ## 为什么要有它
 *
 * 报告给的判据是"新增一条 typed 规则后 `tsc`(17.0s) + typed eslint(23.1s) ≤45 s
 * 且 `eslint .` 保持 <65 s"。判据若只写在文档里，就只是**口号**：下一个人加规则时不会去量，
 * 门禁会一年一年变慢，直到没人愿意跑。故把两条预算做成**实测脚本**：
 *  - 快层 `eslint .` < 65 s；
 *  - 类型层 `tsc --noEmit` + `eslint src --config eslint.typed.config.mjs` 之和 ≤ 45 s。
 * 超预算即退出码非 0，并打印**每一项的实测秒数**（证据，不藏）。
 *
 * ## 口径边界（如实登记）
 *
 * - 本机（Windows / 单进程）实测值受负载影响：并行跑测试时会显著变慢。故预算按"安静机器"标定，
 *   且脚本**打印实测值**，一眼可辨是"代码变慢"还是"当时机器忙"。
 * - 只测**冷启动**（不传 `--cache`）：带缓存的数字好看但不代表 CI 首次运行的真实代价。
 * - 本脚本不参与 pre-commit（它自己就要 ~45 s）——手动 / 轮次全量核验时跑：`npm run gate:budget`。
 *
 * 用法：
 * ```bash
 * npm run gate:budget          # 实测并断言两条预算
 * node scripts/gateBudget.mjs --json   # 只输出 JSON（供其它脚本消费）
 * ```
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAST_BUDGET_SECONDS,
  TYPED_BUDGET_SECONDS,
  TYPED_CONFIG_FILE,
} from './gateBudgetPolicy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TYPED_CONFIG = TYPED_CONFIG_FILE;

/**
 * 跑一条命令并计时（**并发安全**：用 spawn + Promise，不用 spawnSync）。
 * @param argv node 参数数组（相对仓库根）。
 * @returns 耗时（秒，一位小数）与退出码。
 */
function timed(argv) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      // 显式 stdio：本机 stdin 走管道会 EBUSY（见 runGates.mjs 的「诚实边界」）。
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => {
      resolve({
        seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
        status: code ?? 1,
      });
    });
  });
}

const fast = await timed([ESLINT_BIN, '.', '--max-warnings=0']);

// 类型层两项**并发**跑：口径见文件头——开发者真实等待的是墙钟，不是两者相加。
// （相加只在"空载机器"上才稳定 ≤45 s：实测空载 43.9 s、有负载时 49.5 s；墙钟两种情形都在 ~30 s 内。）
const typedStarted = Date.now();
const [tsc, typed] = await Promise.all([
  timed([TSC_BIN, '--noEmit']),
  timed([ESLINT_BIN, 'src', '--config', TYPED_CONFIG, '--max-warnings=0']),
]);
const typedWallSeconds = Math.round(((Date.now() - typedStarted) / 1000) * 10) / 10;
// 「和」的旧口径仍打印出来（报告 §4 G27 写的是"之和"），但**不作为**断言依据：它对机器负载过敏感。
const typedSum = Math.round((tsc.seconds + typed.seconds) * 10) / 10;

const report = {
  fastEslintSeconds: fast.seconds,
  fastBudgetSeconds: FAST_BUDGET_SECONDS,
  tscSeconds: tsc.seconds,
  typedEslintSeconds: typed.seconds,
  typedWallSeconds,
  typedSumSeconds: typedSum,
  typedBudgetSeconds: TYPED_BUDGET_SECONDS,
  fastOk: fast.status === 0 && fast.seconds < FAST_BUDGET_SECONDS,
  typedOk: tsc.status === 0 && typed.status === 0 && typedWallSeconds <= TYPED_BUDGET_SECONDS,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.fastOk && report.typedOk ? 0 : 1);
}

console.log('=== 门禁耗时预算（G27）===');
console.log(
  `快层  eslint .                        ${String(fast.seconds)}s  （预算 < ${String(FAST_BUDGET_SECONDS)}s）` +
    `${fast.status === 0 ? '' : `  ✗ 退出码 ${String(fast.status)}`}`,
);
console.log(`类型层 tsc --noEmit                   ${String(tsc.seconds)}s（并发）`);
console.log(`类型层 eslint --config ${TYPED_CONFIG}  ${String(typed.seconds)}s（并发）`);
console.log(
  `类型层 **墙钟**（开发者实际等待）     ${String(typedWallSeconds)}s  （预算 ≤ ${String(TYPED_BUDGET_SECONDS)}s）`,
);
console.log(
  `类型层 两项之和（报告旧口径，仅供对照）${String(typedSum)}s  —— 对机器负载敏感：空载 ~43.9s、有负载 49.5s` +
    '，故不作断言依据',
);

if (!report.fastOk) {
  console.error(
    `✗ 快层超预算：${String(fast.seconds)}s ≥ ${String(FAST_BUDGET_SECONDS)}s（提交门禁会变慢到没人愿意跑）。`,
  );
}
if (!report.typedOk) {
  console.error(
    `✗ 类型层超预算：墙钟 ${String(typedWallSeconds)}s > ${String(TYPED_BUDGET_SECONDS)}s` +
      `（tsc ${String(tsc.seconds)}s + typed eslint ${String(typed.seconds)}s）` +
      `${tsc.status === 0 && typed.status === 0 ? '' : '（且有一项未通过）'}`,
  );
}
if (!report.fastOk || !report.typedOk) process.exit(1);
console.log('✓ 两层均在预算内');
process.exit(0);
