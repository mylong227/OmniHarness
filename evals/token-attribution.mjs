/**
 * P5 per-tool token 归因报告（离线、零依赖）。
 *
 * 读一条会话的 append-only JSONL 日志（由真实运行产生：`~/.omniharness/sessions/<id>.jsonl`），
 * 把 `model` 事件的 usage 投影到**工具维度**，打印各工具 token 占比。
 *
 * 归因规则见 `src/observability/tokenAttribution.ts`：每次模型调用的 usage 归给
 * 「自上一条 model 事件以来出现的 tool_call 工具名集合」；无前驱工具则归 `<initial>`。
 * 本脚本是**对生产事实源的投影**（事件流即运行时写的日志），不联网、不改状态、不绕过装配层。
 *
 * 用法：`node evals/token-attribution.mjs <session.jsonl>`（构建后）
 * 或：  `npm run metrics:attribution -- <session.jsonl>`
 */
import { readFileSync } from 'node:fs';
import { TokenAttribution } from '../dist/src/observability/tokenAttribution.js';

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write(
    '用法：node evals/token-attribution.mjs <session.jsonl>\n' +
      '（会话日志默认位于 ~/.omniharness/sessions/<sessionId>.jsonl）\n',
  );
  process.exit(1);
}

const events = readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const report = TokenAttribution.fromEvents(events);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num = (x) => Math.round(x).toLocaleString('en-US');
const lines = [];
lines.push('=== P5 per-tool token 归因（模型用量 → 工具维度投影）===');
lines.push(`会话日志: ${path}`);
lines.push(
  `模型调用: 有 usage ${report.modelCallsWithUsage} / 无 usage ${report.modelCallsWithoutUsage}`,
);
lines.push(
  `token 合计 = ${num(report.totalTokens)}` +
    `（输入 ${num(report.totalPromptTokens)} / 输出 ${num(report.totalCompletionTokens)}` +
    ` / 缓存命中 ${num(report.totalCachedPromptTokens)}）`,
);
lines.push('--- 按工具（token 占比，降序）---');
for (const b of report.buckets) {
  lines.push(
    `  ${b.tool.padEnd(24)} calls=${String(b.toolCalls).padStart(4)}` +
      ` tokens=${num(b.totalTokens).padStart(12)} share=${pct(b.share).padStart(6)}` +
      ` (in ${num(b.promptTokens)} / out ${num(b.completionTokens)})`,
  );
}
if (report.modelCallsWithoutUsage > 0) {
  lines.push(
    `注：${report.modelCallsWithoutUsage} 次模型调用端点未上报 usage，无法归因——如实计数，不补零。`,
  );
}
process.stdout.write(`${lines.join('\n')}\n`);
