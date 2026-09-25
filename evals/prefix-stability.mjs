#!/usr/bin/env node
// 前缀稳定性「真实复用率」诊断 + 「动态段位置」受控对照实验（零依赖 · 无网络 · 可复现）。
//
// 动机：仓库早有 `PrefixStability`（能力：canonical 排序 + 易变擦除 + 复用率度量），
// 但生产链路**零调用**（仅 barrel/`src/index.ts` 导出 + 单测消费）——典型缺陷形态
// 「声明未接线」，且属 POLISH_PLAN §2 明列的「`prefixStability` 只测不治」。
//
// 上游 KV / prompt 缓存**只复用字节级公共前缀**，故
//   prefixReuse(cached=上一轮真实请求, incoming=本轮真实请求) = 可复用的已缓存字节占比
// 就是**缓存命中率的上确界**，且是 Harness 侧完全可控、可机械测量的变量。
//
// 本脚本走**生产装配路径**（ConfigFactory.build → createRuntime → 真 Agent 多回合），
// 捕获**运行时真发出的 messages**（不合成、不绕过装配层），回答四个问题：
//   Q1 相邻请求的真实复用率是多少（**同回合追加** vs **跨回合**）？
//   Q2 首次字节分歧落在哪一段内容？
//   Q3 头部系统段是否含**易变字节**（时间戳 / UUID / 临时路径 / pid）？
//   Q4 **受控对照**：把「随回合必变的动态段」（repo-map）从头部移到事件历史**之后**，
//      会话级 token 加权复用率随会话长度的变化如何（**交叉点在哪**）？
//
// 会话级聚合口径：`Σ(reuse_i · prevBytes_i) / Σ prevBytes_i`——即**按字节加权**的复用率，
// 等价于「全会话可缓存字节占比」。单看算术平均会被短请求放大，故不作为判定口径。
//
// 旁路模型调用（长期记忆抽取 / 压缩摘要）按纪律单独计数并**排除**：
// 判定口径写死为「主请求必以 system 段开头」（`stepRunner` 是唯一主请求发出方）。
//
// 用法：npm run build && node evals/prefix-stability.mjs [回合数=4]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Agent } from '../dist/src/core/agent.js';
import { createRuntime } from '../dist/src/core/runtime.js';
import { ConfigFactory } from '../dist/src/config/configFactory.js';
import { MemoryStorage } from '../dist/src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../dist/src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../dist/src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../dist/src/adapters/event/silentEventPort.js';
import { PrefixStability } from '../dist/src/context/prefixStability.js';
import { Canonical } from '../dist/src/context/canonical.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TURNS = Math.max(2, Number(process.argv[2] ?? 4) || 4);
const stability = new PrefixStability();

/**
 * 生产 `config.fragments` 的等价静态前缀（取自 `cliBuildConfig.ts` 的真实基座提示词，
 * 裁到 ~1.4KB 以贴近生产体量）。它**逐字节恒定**，是缓存可命中的稳定头。
 */
const STABLE_FRAGMENT = [
  '你是 OmniHarness 的 AI 助手，运行在用户工作区中。你的首要目标是直接、高效地完成用户任务。',
  '核心行为准则（必须遵守）：',
  '1. 优先直接回答或执行。不要为收集信息而反复调用探索工具。',
  '2. 当用户说"重新试试"、"再试一次"、"再来一次"或类似模糊重试指令时，基于已有上下文和当前工作区状态直接执行最合理的下一步，绝对不要反问用户。',
  '3. `ask_user` 工具只在确实需要用户做选择或提供关键缺失信息时使用；禁止用它澄清模糊指令。',
  '4. 工具执行失败时，先分析原因再重试，不要无意义循环调用同一工具。',
  '5. 当指令模糊或缺少上下文时，最多只做一次轻量确认；若仍不确定，直接给出最佳推测回答。',
  '6. 若用户要求"重新试试"但你找不到明确的前序任务，执行固定 SOP（必须严格遵守，不得偏离）：',
  '   a) 调用 `todo_read` 一次；',
  '   b) 调用 `read_file` 一次，读取当前工作区的 `package.json`；',
  '   c) 基于以上信息按待办最优先项继续执行；',
  '   d) 禁止在该 SOP 中调用 `memory_search`、`list_dir`、`run_code`。',
  '通用工程纪律：改动收尾必须跑门禁；任一非零即视为未完成，须就地修掉再继续。',
  '保持回答简洁；不要复述用户已知信息；不要输出与任务无关的寒暄。',
].join('\n');

/**
 * 录制型模型端口：把**每次真实发出的 messages** 原样留下，再按脚本回应。
 * 不联网、不推理 ⇒ 诊断结果只反映「上下文组装」这一层，与模型能力无关。
 * 旁路调用（消息不以 system 开头者）返回空 JSON，**不消耗主脚本步**。
 */
class RecordingModel {
  /** 端口名。 */
  get name() {
    return 'recording';
  }

  /**
   * @param script 主回路脚本化回应序列（不足时重复最后一项）。
   */
  constructor(script) {
    this.script = script;
    this.mainCalls = 0;
    this.sideCalls = 0;
    /** 每次调用的 messages 快照（role/content/toolCalls 的浅拷贝）。 */
    this.requests = [];
  }

  /**
   * 录制并回应。
   * @param request 模型请求（含 messages / tools）。
   * @returns 主回路按脚本回应；旁路调用回空 JSON 数组。
   */
  async generate(request) {
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
    }));
    this.requests.push(messages);
    if (messages.length === 0 || messages[0].role !== 'system') {
      this.sideCalls += 1;
      return { text: '[]' };
    }
    const step = this.script[Math.min(this.mainCalls, this.script.length - 1)];
    this.mainCalls += 1;
    return step;
  }
}

/**
 * 把消息序列压成「wire 近似」字节串（顺序 + role + content + tool_calls）。
 * 用途仅为逐字节前缀比较，不追求与任何厂商序列化一致。
 * @param messages 消息列表。
 * @returns 拼接后的字符串。
 */
const flatten = (messages) =>
  messages
    .map((m) => {
      const calls = m.toolCalls === undefined ? '' : JSON.stringify(m.toolCalls);
      return `${m.role}\u0001${m.content}\u0001${calls}`;
    })
    .join('\u0002');

/**
 * 取「头部系统段」= 消息序列开头连续的 system 消息（生产顺序为
 * `[fragments…, 常驻指令, repo-map] → 事件历史`）。
 * @param messages 消息列表。
 * @returns 头部系统段内容数组。
 */
const leadingSystemSegments = (messages) => {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'system') break;
    out.push(m.content);
  }
  return out;
};

/**
 * 判定头部系统段跨主请求的稳定性（同一段位是否逐字节相同）。
 * @param requests 主请求的消息序列数组。
 * @returns 每个段位的 `{ index, presentInAll, byteIdentical, chars, volatileBytesScrubbed }`。
 */
const analyzeSegments = (requests) => {
  const maxSegments = Math.max(0, ...requests.map((m) => leadingSystemSegments(m).length));
  const out = [];
  for (let j = 0; j < maxSegments; j += 1) {
    const texts = requests.map((m) => leadingSystemSegments(m)[j]);
    const presentInAll = texts.every((t) => typeof t === 'string');
    out.push({
      index: j,
      presentInAll,
      byteIdentical: presentInAll && texts.every((t) => t === texts[0]),
      chars: presentInAll ? texts[0].length : 0,
      volatileBytesScrubbed: presentInAll
        ? texts[0].length - Canonical.scrubVolatile(texts[0]).length
        : 0,
      preview: presentInAll ? texts[0].slice(0, 60).replace(/\n/g, '⏎') : '',
    });
  }
  return out;
};

/**
 * 反事实重排：把**非稳定**头部系统段移到事件历史之后（稳定段留在原位）。
 * @param messages 消息列表。
 * @param unstable 非稳定段位下标集合。
 * @returns 重排后的消息列表。
 */
const moveUnstableToTail = (messages, unstable) => {
  const count = leadingSystemSegments(messages).length;
  if (count === 0 || unstable.size === 0) return messages;
  const head = [];
  const moved = [];
  messages.forEach((m, i) => {
    if (i < count && unstable.has(i)) moved.push(m);
    else head.push(m);
  });
  return [...head, ...moved];
};

/**
 * 定位首次字节分歧落在第几条消息。
 * @param prev 上一轮消息列表。
 * @param cur 本轮消息列表。
 * @returns `{ messageIndex, role }`；无分歧时 messageIndex = -1。
 */
const locateDivergence = (prev, cur) => {
  const limit = Math.min(prev.length, cur.length);
  for (let i = 0; i < limit; i += 1) {
    if (flatten([prev[i]]) !== flatten([cur[i]])) {
      return { messageIndex: i, role: prev[i].role };
    }
  }
  if (prev.length !== cur.length) return { messageIndex: limit, role: '(新增消息)' };
  return { messageIndex: -1, role: '(无分歧)' };
};

/**
 * 构造最小可用配置（走 ConfigFactory.build）。
 * - `memoryConsolidate:false` 剔除「回合末蒸馏」旁路模型调用。
 * - `compactionMaxTokens` 取极大值 ⇒ **关闭压缩**：压缩会替换头部（摘要），
 *   是另一个独立变量，必须隔离（否则测到的是压缩而非动态段位置）。
 * @param model 录制型模型端口。
 * @returns 可交给 ConfigFactory.build 的输入。
 */
const base = (model) => ({
  workspaceRoot: ROOT,
  maxSteps: 8,
  model,
  storage: new MemoryStorage(),
  approvals: new AutoApproval(),
  sandbox: new PassthroughSandbox(),
  events: new SilentEventPort(),
  memoryConsolidate: false,
  compactionMaxTokens: 100_000_000,
  fragments: [STABLE_FRAGMENT],
});

/** 每回合读一个不同的真实源文件（保证查询文本与 repo-map 逐回合变化）。 */
const TARGETS = [
  'src/context/contextAssembler.ts',
  'src/context/prefixStability.ts',
  'src/context/canonical.ts',
  'src/context/tokenEstimator.ts',
  'src/context/projectInstructions.ts',
  'src/context/deterministicCompressor.ts',
  'src/context/contextCompactor.ts',
  'src/context/contextBreakdownEstimator.ts',
];

/** 生成 TURNS 回合脚本：每回合「读文件 → 收尾」= 2 次主请求。 */
const buildScript = () => {
  const script = [];
  for (let t = 0; t < TURNS; t += 1) {
    const path = TARGETS[t % TARGETS.length];
    script.push({ toolCalls: [{ id: `r${t}`, name: 'read_file', arguments: { path } }] });
    script.push({ text: `回合${t + 1}完成` });
  }
  return script;
};

const model = new RecordingModel(buildScript());
const runtime = createRuntime(ConfigFactory.build(base(model)));
const agent = new Agent(runtime);

/** 逐回合驱动；记录每回合结束时的主请求数量（用于按会话长度截断重算）。 */
const boundaries = [];
let sessionId;
const allRequests = () => model.requests.filter((m) => m.length > 0 && m[0].role === 'system');
for (let t = 0; t < TURNS; t += 1) {
  const prompt = `读一下 ${TARGETS[t % TARGETS.length]}`;
  if (sessionId === undefined) {
    const res = await agent.runTask(prompt);
    sessionId = res.sessionId;
  } else {
    await agent.resume(sessionId, prompt);
  }
  boundaries.push(allRequests().length);
}

const requests = allRequests();
const segments = analyzeSegments(requests);
const unstable = new Set(segments.filter((s) => !s.byteIdentical).map((s) => s.index));

const pairAt = (i) => {
  const prev = requests[i - 1];
  const cur = requests[i];
  const prevFlat = flatten(prev);
  const curFlat = flatten(cur);
  const prevSegs = leadingSystemSegments(prev);
  const curSegs = leadingSystemSegments(cur);
  const sameHead = prevSegs.length === curSegs.length && prevSegs.every((t, j) => t === curSegs[j]);
  const diverged = locateDivergence(prev, cur);
  return {
    step: i,
    kind: sameHead ? '同回合追加' : '跨回合',
    prevBytes: prevFlat.length,
    curBytes: curFlat.length,
    reuse: stability.prefixReuse(prevFlat, curFlat),
    reuseTail: stability.prefixReuse(
      flatten(moveUnstableToTail(prev, unstable)),
      flatten(moveUnstableToTail(cur, unstable)),
    ),
    commonPrefixChars: stability.commonPrefixLength(prevFlat, curFlat),
    divergentMessageIndex: diverged.messageIndex,
    divergentMessageRole: diverged.role,
  };
};

const pairs = [];
for (let i = 1; i < requests.length; i += 1) pairs.push(pairAt(i));

/** 会话级 token（字节）加权复用率：`Σ(reuse·prevBytes)/Σ prevBytes`。 */
const weighted = (list, key) => {
  const total = list.reduce((s, p) => s + p.prevBytes, 0);
  return total === 0 ? 0 : list.reduce((s, p) => s + p[key] * p.prevBytes, 0) / total;
};

/** 交叉曲线：把会话截断到前 k 回合，分别在「头部（现状）」与「尾部（治疗）」下聚合。 */
const curve = [];
for (let k = 0; k < boundaries.length; k += 1) {
  const upTo = boundaries[k];
  const slice = pairs.filter((p) => p.step < upTo);
  if (slice.length === 0) continue;
  curve.push({
    turns: k + 1,
    requests: upTo,
    bytes: slice.reduce((s, p) => s + p.prevBytes, 0),
    headWeightedReuse: weighted(slice, 'reuse'),
    tailWeightedReuse: weighted(slice, 'reuseTail'),
    crossTurnCount: slice.filter((p) => p.kind === '跨回合').length,
  });
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const lines = [];
lines.push('=== 前缀稳定性诊断（真实复用率 = 缓存命中率上确界）===');
lines.push(
  `工作区: repo-root（本仓库真实源码语料；无 AGENTS.md/CLAUDE.md ⇒ 头部 = 静态 fragments + repo-map）`,
);
lines.push(
  `会话 ${sessionId}：${TURNS} 回合；主请求 ${requests.length} 次` +
    `（旁路模型调用 ${model.sideCalls} 次，已排除）`,
);
lines.push('');
lines.push('头部系统段（volatile = scrubVolatile 会擦掉的字节数）:');
for (const s of segments) {
  lines.push(
    `  seg#${s.index}  ${String(s.chars).padStart(6)} 字符  volatile ${String(s.volatileBytesScrubbed).padStart(4)}  ` +
      `逐字节相同=${s.byteIdentical}  「${s.preview}…」`,
  );
}
lines.push('');
lines.push('各主请求头部系统段字符数（用于确认稳定段是否真的稳定）:');
lines.push(
  `  ${requests
    .map(
      (m, i) =>
        `#${i}:[${leadingSystemSegments(m)
          .map((t) => t.length)
          .join(',')}]`,
    )
    .join('  ')}`,
);
lines.push('');
lines.push('相邻主请求明细（前 8 对）:');
lines.push(
  '  #       类型  上一轮字节  本轮字节   复用率  公共前缀  首分歧消息  角色   尾部方案复用率',
);
for (const p of pairs.slice(0, 8)) {
  lines.push(
    `  ${String(p.step).padStart(2)}  ${p.kind.padStart(6)}  ${String(p.prevBytes).padStart(9)}  ${String(p.curBytes).padStart(9)}  ` +
      `${pct(p.reuse).padStart(7)}  ${String(p.commonPrefixChars).padStart(8)}  ` +
      `${String(p.divergentMessageIndex).padStart(10)}  ${p.divergentMessageRole.padStart(6)}  ` +
      `${pct(p.reuseTail).padStart(13)}`,
  );
}
lines.push('');
lines.push('受控对照：会话级 token 加权复用率（口径 Σ(reuse·prevBytes)/ΣprevBytes）');
lines.push('  会话长度     累计字节   现状(动态段在头部)   尾部方案   跨回合对数');
for (const c of curve) {
  lines.push(
    `  ${String(c.turns).padStart(2)} 回合  ${String(c.bytes).padStart(10)}  ` +
      `${pct(c.headWeightedReuse).padStart(17)}  ${pct(c.tailWeightedReuse).padStart(9)}  ` +
      `${String(c.crossTurnCount).padStart(10)}`,
  );
}
const last = curve[curve.length - 1];
const firstCross = curve.find((c) => c.tailWeightedReuse > c.headWeightedReuse);
lines.push('');
lines.push(
  `终态（${last.turns} 回合）: 现状 ${pct(last.headWeightedReuse)} vs 尾部 ${pct(last.tailWeightedReuse)}` +
    `  ⇒ 差 ${((last.tailWeightedReuse - last.headWeightedReuse) * 100).toFixed(2)}pp`,
);
lines.push(
  firstCross === undefined
    ? '交叉点: 本会话长度内**尚未交叉**（尾部方案始终不劣于… 未反超，需更长会话）'
    : `交叉点: 会话达到 **${firstCross.turns} 回合** 时尾部方案开始反超`,
);

const report = {
  eval: 'prefix-stability',
  batch: 'polish-5/token-效率·前缀复用',
  generatedAt: new Date().toISOString(),
  // 纪律：报告不落机器绝对路径（与 evals/*.report.json 既有约定一致）。
  workspace: 'repo-root（本仓库真实源码语料）',
  sessionId,
  turns: TURNS,
  mainRequestCount: requests.length,
  sideChannelCallCount: model.sideCalls,
  segments,
  unstableSegmentIndexes: [...unstable],
  pairs,
  curve,
  crossoverTurns: firstCross === undefined ? null : firstCross.turns,
  headWeightedReuseFinal: last.headWeightedReuse,
  tailWeightedReuseFinal: last.tailWeightedReuse,
};
const outPath = join(ROOT, 'evals', 'prefix-stability.report.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
lines.push('');
lines.push(`报告: ${outPath}`);

process.stdout.write(`${lines.join('\n')}\n`);
