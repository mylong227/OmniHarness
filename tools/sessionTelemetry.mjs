#!/usr/bin/env node
/**
 * 会话遥测分析器（离线、零依赖、免模型）。
 *
 * ## 回答什么问题
 *
 * 「长会话到底把时间和 token 花在了哪里」——只看单次会话的直觉不可靠。本工具扫描
 * `~/.omniharness/sessions/*.jsonl`，把每个**真实模型会话**（有 `model` 事件）的
 * 墙钟 / 有效时长 / 调用数 / token / 缓存命中 / 压缩次数 / 工具失败 / **结果冗余** 汇总成表。
 *
 * 关键口径：
 *  - **有效时长** = 墙钟 − 空闲间隔（>5 分钟且间隔之后是用户消息的间隔）。人离开一夜再回来
 *    的会话，墙钟 8 小时、有效时长可能只有 2 分钟；直接看墙钟会把「挂机」误读成「跑了很久」。
 *  - **结果冗余** = 同一「工具 + 结果内容指纹」在会话内重复出现（第 2 次起计数）。长会话里
 *    最烧钱的一种病是同一文件被反复 `read_file`、同一目录被反复 `list_dir`；调用签名可能不同
 *    （offset/limit 变化），只有内容指纹能识别。
 *  - **mock 会话**（`MockModel`）没有 `model` 事件，默认不计入统计，只报数量——它们会让
 *    「150 个会话」这类计数严重失真。
 *
 * ## 用法
 *
 * ```bash
 * node tools/sessionTelemetry.mjs                       # 真实会话汇总
 * node tools/sessionTelemetry.mjs --dir=<sessions目录>   # 指定存档目录
 * node tools/sessionTelemetry.mjs --json=out.json        # 机器可读
 * node tools/sessionTelemetry.mjs --all                  # 连 mock 会话一起列出
 * ```
 *
 * ## 诚实边界
 *
 * - 只读事件日志，不读模型/费用账单；成本按 `deepseek-v4-flash` 公开单价**估算**（0.30/1.20/
 *   0.006 USD per 1M），不是真实计费；
 * - 「有效时长」是启发式（5 分钟阈值），短暂离开仍会算进有效时长；
 * - 结果指纹是 FNV-1a 32 位，只用于相等比较，不抗碰撞；
 * - 会话日志里没有「用户取消」事件，因此无法区分「被取消」与「正常结束」。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 命令行 `--key=value` 解析（未知键忽略，保持离线工具简单）。 */
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const matched = /^--([^=]+)=(.*)$/s.exec(arg);
  if (matched !== null) args.set(matched[1], matched[2]);
}
const DIR = resolve(
  args.get('dir') ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.omniharness', 'sessions'),
);
const OUT = args.get('json');
const INCLUDE_MOCK = args.has('all');
const IDLE_MS = 5 * 60 * 1000;
const PRICE = { in: 0.3, out: 1.2, cached: 0.006 };

/** FNV-1a 32 位指纹（只用于相等比较）。 */
const fingerprint = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * 解析单个会话。
 * @param {string} name 文件名
 * @returns {object|null} 统计行；不可读时为 null
 */
function analyze(name) {
  let text;
  try {
    text = readFileSync(join(DIR, name), 'utf8');
  } catch {
    return null;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行跳过（存档可能正在追加） */
    }
  }
  const hasModel = events.some((event) => event.type === 'model');
  if (!hasModel && !INCLUDE_MOCK) {
    return { name, mock: true, bytes: text.length };
  }
  let first = null;
  let last = null;
  let prev = null;
  let idleMs = 0;
  let idleCount = 0;
  const byTool = new Map();
  const failByTool = new Map();
  const resultHash = new Map();
  const callById = new Map();
  let redundant = 0;
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let calls = 0;
  let maxCtx = 0;
  let compaction = 0;
  let title = '';
  let workspace = '';
  let model = '';
  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (Number.isNaN(ts)) continue;
    if (first === null) first = ts;
    last = ts;
    if (prev !== null) {
      const gap = ts - prev;
      // 空闲 = 长间隔且间隔之后是用户消息（人离开再回来）；模型生成延迟不算空闲。
      if (gap > IDLE_MS && event.type === 'user') {
        idleMs += gap;
        idleCount += 1;
      }
    }
    const payload = event.payload ?? {};
    if (event.type === 'user' && title === '' && typeof payload.content === 'string') {
      title = payload.content.slice(0, 50);
    }
    if (event.type === 'session_meta') workspace = String(payload.workspace ?? '');
    if (event.type === 'system' && String(payload.content ?? '').startsWith('OMNI_COMPACTION_V1')) {
      compaction += 1;
    }
    if (event.type === 'model') {
      calls += 1;
      const usage = payload.usage ?? {};
      prompt += Number(usage.promptTokens ?? 0);
      cached += Number(usage.cachedPromptTokens ?? 0);
      completion += Number(usage.completionTokens ?? 0);
      maxCtx = Math.max(maxCtx, Number(payload.context?.usedTokens ?? 0));
      model = String(payload.model ?? model);
    }
    if (event.type === 'tool_call') {
      callById.set(payload.callId, payload.name);
      byTool.set(payload.name, (byTool.get(payload.name) ?? 0) + 1);
    }
    if (event.type === 'tool_result') {
      const tool = callById.get(payload.callId) ?? '?';
      if (payload.ok === false) failByTool.set(tool, (failByTool.get(tool) ?? 0) + 1);
      const output = typeof payload.output === 'string' ? payload.output : '';
      if (output.length >= 64) {
        const fp = `${tool}::${fingerprint(output)}`;
        const seen = resultHash.get(fp) ?? 0;
        resultHash.set(fp, seen + 1);
        if (seen >= 1) redundant += 1;
      }
    }
    prev = ts;
  }
  if (first === null) return null;
  const wall = (last - first) / 1000;
  const active = Math.max(0, (last - first - idleMs) / 1000);
  const cost =
    (cached / 1e6) * PRICE.cached +
    ((prompt - cached) / 1e6) * PRICE.in +
    (completion / 1e6) * PRICE.out;
  return {
    name,
    mock: !hasModel,
    title,
    workspace,
    model,
    wall,
    active,
    idleCount,
    calls,
    prompt,
    cached,
    completion,
    cachePct: prompt > 0 ? (cached / prompt) * 100 : 0,
    maxCtx,
    compaction,
    redundant,
    toolCalls: [...byTool.values()].reduce((a, b) => a + b, 0),
    fails: [...failByTool.values()].reduce((a, b) => a + b, 0),
    failByTool: Object.fromEntries(failByTool),
    byTool: Object.fromEntries(byTool),
    cost,
    bytes: text.length,
  };
}

const all = readdirSync(DIR)
  .filter((name) => name.endsWith('.jsonl'))
  .sort()
  .map(analyze)
  .filter((row) => row !== null);
const mock = all.filter((row) => row.mock);
const rows = all.filter((row) => !row.mock).sort((a, b) => b.active - a.active);
const sum = (key) => rows.reduce((total, row) => total + row[key], 0);

console.log(`dir=${DIR}`);
console.log(`sessions=${all.length}  real=${rows.length}  mock=${mock.length}`);
console.log(
  `active=${(sum('active') / 60).toFixed(1)}min  wall=${(sum('wall') / 3600).toFixed(2)}h  ` +
    `idleGaps=${sum('idleCount')}`,
);
console.log(
  `calls=${sum('calls')}  prompt=${sum('prompt')}  cached=${sum('cached')}  output=${sum('completion')}`,
);
console.log(
  `cost≈$${sum('cost').toFixed(2)}  redundant=${sum('redundant')}  fails=${sum('fails')}  ` +
    `bytes=${(sum('bytes') / 1048576).toFixed(2)}MiB`,
);
for (const row of rows) {
  const tools = Object.entries(row.byTool)
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
  const fails = Object.entries(row.failByTool)
    .map(([name, count]) => `${name}:${count}`)
    .join(',');
  console.log(
    `\n${row.name}  ${row.active.toFixed(0)}s active / ${row.wall.toFixed(0)}s wall` +
      `${row.idleCount > 0 ? ` (idle ${row.idleCount})` : ''}\n` +
      `  ${row.calls} calls | prompt ${row.prompt} cache ${row.cachePct.toFixed(1)}% | ` +
      `out ${row.completion} | ctxMax ${row.maxCtx} | compact ${row.compaction}\n` +
      `  tools ${row.toolCalls} (${tools})\n` +
      `  fails ${row.fails} (${fails || '-'}) | redundant ${row.redundant} | ` +
      `$${row.cost.toFixed(2)} | ${row.title}`,
  );
}
if (mock.length > 0) {
  console.log(
    `\nmock sessions: ${mock.length}（无 model 事件，未计入统计；加 --all 可列出）` +
      `  bytes=${(mock.reduce((total, row) => total + row.bytes, 0) / 1048576).toFixed(2)}MiB`,
  );
}
if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ dir: DIR, rows, mockCount: mock.length }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
