// 上下文热路径的 CPU profiling 脚本（2026-10-18）。
//
// 目的：用**真实数据**定位「每个回合都要跑一次」的那段组装/记账成本，而不是凭猜测优化。
// 用法（先构建；脚本消费 dist 产物，与生产走同一份代码路径）：
//   npm run build
//   npm run perf:context                                  # 只跑计时
//   node --cpu-prof --cpu-prof-dir=.tmp/prof scripts/profileContextHotpath.mjs
// 然后把 .tmp/prof 里的 .cpuprofile 按 samples/timeDeltas 聚合 self time（见 board §21.2）。
//
// 场景刻意贴近长会话：300 条消息 / ≈2.5 MB 正文（含工具调用），逐条估算 + 逐轮做
// 「是否有必要压缩」的预算判断，重复 60 轮（≈ 一次长会话里几十步的稳态）。
import { TokenEstimator } from '../dist/src/context/tokenEstimator.js';
import { PrefixStability } from '../dist/src/context/prefixStability.js';

/** 造一条正文。 */
function body(i, kb) {
  return `第 ${i} 段：${'x'.repeat(kb * 1024)}\n`;
}

/** 造会话消息。 */
function buildMessages(count, kbEach) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const assistant = i % 3 === 2;
    list.push({
      role: assistant ? 'assistant' : i % 2 === 0 ? 'user' : 'tool',
      content: body(i, kbEach),
      ...(assistant
        ? {
            toolCalls: [
              {
                id: `call_${i}`,
                name: 'read_file',
                arguments: { path: `src/module${i}.ts`, offset: i * 10, limit: 200 },
              },
            ],
          }
        : {}),
    });
  }
  return list;
}

const messages = buildMessages(300, 8); // ≈ 2.5 MB
const estimator = new TokenEstimator();
const json = (m) => JSON.stringify(m);
const serialized = messages.map(json);

const ROUNDS = 60;
const started = performance.now();
let sink = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  // 1) 每轮记账：逐条估算（缓存按内容长度生效，所以每轮都是"新内容"最坏情况之一）
  sink += estimator.estimateMessages(messages);
  // 2) 压缩预算判断：把消息文本拼起来量长度（压缩器内部同款口径）
  let chars = 0;
  for (const s of serialized) chars += s.length;
  sink += chars;
  // 3) 前缀复用率：CJK 字符串的公共前缀扫描（生产路径里每步一次）
  sink += Math.round(
    PrefixStability.prefixReuse(serialized[0] + serialized[1], serialized[1] + serialized[0]) *
      1000,
  );
  // 4) 序列化：本轮新增/改写的那条消息
  const fresh = { role: 'assistant', content: body(round, 2) };
  sink += json(fresh).length;
}
const elapsed = performance.now() - started;
process.stdout.write(
  `ctx-hotpath: ${ROUNDS} 轮 × 300 条/2.5MB = ${elapsed.toFixed(0)} ms（${(elapsed / ROUNDS).toFixed(1)} ms/轮），sink=${sink}\n`,
);
