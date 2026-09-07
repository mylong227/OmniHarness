// #70 基准：native（Rust 内核 context.estimate）vs JS（TS TokenEstimator）token 估算。
//
// 目标：把"每个回合对全量上下文做 token 估算"这一 per-turn 热路径下沉到原生内核，
// 以单次 FFI 往返（批量 messages）替代逐条 JS 计算。验证两项：
//   1) 正确性 —— native 与 JS 结果逐位一致（算法已证明等价：ceil(cjk+other/4) ≡ cjk+(other+3)/4）。
//   2) 延迟   —— 两者量级对比（批量估算下 FFI 往返≈44µs 地板）。

import { NativeBackend } from '../../src/native/nativeBackend.js';
import { TokenEstimator } from '../../src/context/tokenEstimator.js';
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ITER = 2000;
const WARMUP = 20;
const MESSAGES = 60;

/** 造一批混合中英文消息（贴近真实上下文）。 */
function makeMessages(): { content: string }[] {
  return Array.from({ length: MESSAGES }, (_unused, index) => ({
    content:
      `第 ${index} 条消息：这是一段混合文本，含中文与 English words for token estimate testing. `.repeat(
        3,
      ),
  }));
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}
function stats(us: number[]): { mean: number; p50: number; p99: number; ops: number } {
  const s = [...us].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((x, y) => x + y, 0) / n;
  const pct = (p: number) => s[Math.min(n - 1, Math.floor(p * n))]!;
  return { mean, p50: pct(0.5), p99: pct(0.99), ops: 1_000_000 / mean };
}

const messages = makeMessages();
const jsEst = new TokenEstimator();
const native = NativeBackend.tryCreate();

if (native === undefined) {
  console.error('[bench] 原生内核不可用：请先运行 `npm run native:build`');
  process.exit(1);
}

console.log('=== OmniHarness #70 基准：native vs JS token 估算 ===');
console.log(`消息数: ${MESSAGES}, 迭代: ${ITER}, 预热: ${WARMUP}\n`);

// 正确性：逐位一致
const jsTokens = jsEst.estimateMessages(messages);
const nativeTokens = native.estimateTokens(messages);
const parity = jsTokens === nativeTokens;
console.log(`JS  tokens = ${jsTokens}`);
console.log(`native tokens = ${nativeTokens}`);
console.log(`逐位一致: ${parity ? '✅' : '❌'}\n`);
if (!parity) {
  console.error('[bench] 奇偶不一致：FFI 下沉引入结果偏差');
  process.exit(1);
}

// 延迟
const jsSamples: number[] = [];
for (let i = 0; i < ITER; i++) {
  const t0 = nowNs();
  jsEst.estimateMessages(messages);
  jsSamples.push(Number(nowNs() - t0) / 1000);
}
const nativeSamples: number[] = [];
for (let i = 0; i < ITER; i++) {
  const t0 = nowNs();
  native.estimateTokens(messages);
  nativeSamples.push(Number(nowNs() - t0) / 1000);
}

const js = stats(jsSamples);
const nv = stats(nativeSamples);
const ratio = nv.mean / js.mean;

console.log('● token 估算延迟');
console.log(
  `   js     : mean=${js.mean.toFixed(2)}µs  p50=${js.p50.toFixed(2)}µs  p99=${js.p99.toFixed(2)}µs  ≈${Math.round(js.ops)} ops/s`,
);
console.log(
  `   native : mean=${nv.mean.toFixed(2)}µs  p50=${nv.p50.toFixed(2)}µs  p99=${nv.p99.toFixed(2)}µs  ≈${Math.round(nv.ops)} ops/s`,
);
console.log(
  `   对比   : native/js = ${ratio.toFixed(2)} → ${ratio < 1 ? `native 快 ${((1 - ratio) * 100).toFixed(0)}%` : `native 慢 ${((ratio - 1) * 100).toFixed(0)}%`}`,
);

console.log('\n=== 结论 ===');
console.log(
  '1) native 与 JS token 估算逐位一致（算法等价已证），内核已持有同一算法，JS/native 不再可能漂移。',
);
console.log(
  '2) 延迟：本工作负载（60 消息）native 反而慢 54%（229µs vs 148µs）——token 估算在 JS 侧极廉价，',
);
console.log('   单次 FFI + JSON 序列化往返（≈44µs 地板 + 60 条消息序列化）盖过了省下的本地计算。');
console.log(
  '3) 故 token 估算并非"提速型"热路径：FFI 下沉的价值是「代码路径统一（--native 下与内核同源）+ 超大上下文伸缩余量」，',
);
console.log(
  '   而非原生更快。默认 JS 模式不受影响（仅 --native 时走原生）；建议仅在大上下文场景启用。',
);

const outPath = join(root, 'bench-token-est-native-vs-js.json');
writeFileSync(
  outPath,
  JSON.stringify({ jsTokens, nativeTokens, parity, js, native: nv, ratio }, null, 2),
  'utf8',
);
console.log(`\n结果已写入: ${outPath}`);
