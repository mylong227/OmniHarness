#!/usr/bin/env node
// 提示缓存「真机两轮」探针：用**同一个稳定前缀**连发两次请求，证明缓存**真的命中**。
//
// 为什么需要它：仓库里已有「读取缓存字段」（PromptCacheUsageReader）、「按缓存价折抵成本」
// （CostBudget）、「从事件回放算命中率」（ContextUsageService）三处逻辑，但它们全部是
// **静态逻辑**——没有任何一处证据能回答「这个端点在真实请求上到底命不命中」。
// 数值再自洽，只要端点不缓存 / 前缀不稳定 / 缺 cache_control，命中率就恒为 0 而无人知道。
// 本脚本用两轮真机调用的 `cachedPromptTokens` 把这件事**变成可失败的事实**。
//
// 口径（对齐生产读取路径，不自己造解析）：
//   · 请求体走 OpenAI 兼容 `chat/completions`（DeepSeek / OpenAI / 兼容网关同形）；
//   · 命中量用编译产物里的 `PromptCacheUsageReader.readOpenAiCompatible` 读取——
//     与 `openAiCompatibleModel` 生产路径**同一份实现**，含 DeepSeek 的
//     `prompt_cache_hit_tokens` 与 OpenAI 的 `prompt_tokens_details.cached_tokens` 两种形态。
//
// 判定：第二轮 `cachedPromptTokens > 0` ⇒ exit 0（缓存确实命中）；
//       等于 0 或字段缺失 ⇒ exit 非 0 + 可执行建议（`--allow-zero` 可显式豁免）。
//
// 凭据只从环境读，绝不写进任何被提交的文件：
//   node --env-file=.env evals/cache-probe.mjs
//
// 环境变量（前者优先，后者为通用回退）：
//   DEEPSEEK_API_KEY / OMNIHARNESS_API_KEY   必填
//   DEEPSEEK_BASE_URL / OMNIHARNESS_BASE_URL 缺省 https://api.deepseek.com
//   DEEPSEEK_MODEL / OMNIHARNESS_MODEL       缺省 deepseek-chat
//   OMNI_CACHE_PROBE_FILE                    作为稳定前缀的文件（缺省取本仓库一个中等文件）
//   OMNI_CACHE_PROBE_DELAY_MS                两轮之间的等待（缺省 1500，给端点留写入缓存的时间）
//
// 用法：
//   node --env-file=.env evals/cache-probe.mjs            # 真机两轮
//   node evals/cache-probe.mjs --simulate                 # 干跑：验证失败路径与退出码（不联网）
//   node --env-file=.env evals/cache-probe.mjs --allow-zero

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptCacheUsageReader } from '../dist/src/adapters/model/promptCacheUsageReader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const READER = new PromptCacheUsageReader();

/** 默认前缀文件：本仓库里一个中等体积、内容稳定的源文件。 */
const DEFAULT_PREFIX_FILE = 'src/adapters/model/promptCacheUsageReader.ts';

/**
 * 读环境变量（两个名字依次回退）。
 * @param {string} primary 首选变量名
 * @param {string} fallback 回退变量名
 * @returns {string | undefined} 值（去空白；空串视为未配置）
 */
function envOf(primary, fallback) {
  for (const key of [primary, fallback]) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

/**
 * 读单个环境变量（无回退名时用）。
 * @param {string} key 变量名
 * @returns {string | undefined} 值（去空白；空串视为未配置）
 */
function envOne(key) {
  return envOf(key, key);
}

/**
 * 拼接 chat/completions 端点（容忍 baseUrl 已带或不带 /v1）。
 * @param {string} baseUrl 端点基址
 * @returns {string} 完整 URL
 */
function completionsUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const withVersion = /\/v\d+$/.test(base) ? base : `${base}/v1`;
  return `${withVersion}/chat/completions`;
}

/**
 * 读稳定前缀文本。
 * @returns {{path: string, text: string}} 文件相对路径与内容
 */
function readPrefix() {
  const configured = envOne('OMNI_CACHE_PROBE_FILE');
  const relative = configured ?? DEFAULT_PREFIX_FILE;
  const absolute = resolve(ROOT, relative);
  const text = readFileSync(absolute, 'utf8');
  return { path: relative, text };
}

/**
 * 估算字符数对应的 token 量级（仅用于「前缀是否够长」的粗判，不做精确计费）。
 * @param {string} text 文本
 * @returns {number} 粗估 token 数（CJK 按 1 字 1 token，其余按 4 字符 1 token）
 */
function roughTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * 发一轮请求并解析 usage。
 * @param {{url: string, apiKey: string, model: string, messages: unknown[], maxTokens: number}} cfg 请求配置
 * @param {string} label 轮次标签（用于错误信息）
 * @returns {Promise<{promptTokens: number|undefined, cachedPromptTokens: number|undefined, completionTokens: number|undefined, text: string, raw: unknown}>} 解析结果
 */
async function callOnce(cfg, label) {
  const response = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: cfg.messages,
      max_tokens: cfg.maxTokens,
      temperature: 0,
      stream: false,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${bodyText.slice(0, 400)}`);
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`${label} 响应不是 JSON: ${bodyText.slice(0, 200)}`);
  }
  const usage = body?.usage ?? undefined;
  return {
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens:
      typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    // 与生产路径同一份读取器：缺字段 ⇒ undefined（「未知」），不是 0。
    cachedPromptTokens: READER.readOpenAiCompatible(usage),
    text: String(body?.choices?.[0]?.message?.content ?? ''),
    raw: usage,
  };
}

/**
 * 打印一行表格。
 * @param {string[]} cells 单元格
 * @param {number[]} widths 各列宽度
 * @returns {void}
 */
function printRow(cells, widths) {
  const line = cells.map((cell, i) => String(cell).padEnd(widths[i] ?? 0)).join(' | ');
  console.log(line.trimEnd());
}

/**
 * 打印两轮结果表并给出判定（设置 process.exitCode）。
 * @param {{promptTokens: number|undefined, cachedPromptTokens: number|undefined, completionTokens: number|undefined, text: string, raw: unknown}} round1 第 1 轮结果
 * @param {{promptTokens: number|undefined, cachedPromptTokens: number|undefined, completionTokens: number|undefined, text: string, raw: unknown}} round2 第 2 轮结果
 * @param {{allowZero: boolean, delayMs: number, prefix: string, ms1: number, ms2: number}} opts 判定选项
 * @returns {void}
 */
function reportAndVerdict(round1, round2, opts) {
  const hitRate = (r) =>
    r.promptTokens !== undefined && r.promptTokens > 0 && r.cachedPromptTokens !== undefined
      ? `${((r.cachedPromptTokens / r.promptTokens) * 100).toFixed(1)}%`
      : 'n/a';
  const cachedText = (r) =>
    r.cachedPromptTokens === undefined ? '缺失(未知)' : String(r.cachedPromptTokens);

  const widths = [6, 13, 13, 8, 7, 20];
  printRow(['轮次', 'prompt_tokens', 'cached_tokens', '命中率', '耗时', '回答'], widths);
  printRow(
    [
      '1',
      String(round1.promptTokens ?? '缺失'),
      cachedText(round1),
      hitRate(round1),
      `${opts.ms1}ms`,
      round1.text.slice(0, 18),
    ],
    widths,
  );
  printRow(
    [
      '2',
      String(round2.promptTokens ?? '缺失'),
      cachedText(round2),
      hitRate(round2),
      `${opts.ms2}ms`,
      round2.text.slice(0, 18),
    ],
    widths,
  );
  console.log('');
  console.log(`第 1 轮原始 usage: ${JSON.stringify(round1.raw)}`);
  console.log(`第 2 轮原始 usage: ${JSON.stringify(round2.raw)}`);
  console.log('');

  const cached2 = round2.cachedPromptTokens;
  if (cached2 !== undefined && cached2 > 0) {
    const denom = round2.promptTokens ?? 0;
    const rate = denom > 0 ? ((cached2 / denom) * 100).toFixed(1) : 'n/a';
    console.log(
      `✅ 缓存命中：第 2 轮 cachedPromptTokens=${cached2}（命中率 ${rate}%）⇒ 前缀缓存真实生效。`,
    );
    process.exitCode = 0;
    return;
  }

  console.log(
    `❌ 未命中缓存：第 2 轮 cachedPromptTokens=${cached2 === undefined ? '缺失' : cached2}（第 1 轮=${round1.cachedPromptTokens === undefined ? '缺失' : round1.cachedPromptTokens}）。`,
  );
  console.log('可能原因与排查顺序（逐条可执行）：');
  console.log(
    '  1. 端点不支持前缀缓存：确认网关是否原样透传 usage 的缓存字段（部分代理会剥掉 *details）。',
  );
  console.log(
    '  2. 前缀不稳定：两次请求的 system/前缀必须逐字节相同，动态内容（时间戳、随机 id、repo-map）不得出现在前缀里。',
  );
  console.log(
    `  3. 前缀过短：多数端点只缓存 ≥64 token 的前缀；本次约 ${roughTokens(opts.prefix)} token，可用 OMNI_CACHE_PROBE_FILE 指定更大文件。`,
  );
  console.log(
    `  4. 缓存尚未落盘：端点写入有延迟，可提高 OMNI_CACHE_PROBE_DELAY_MS（当前 ${opts.delayMs}ms）后再试。`,
  );
  console.log(
    '  5. Anthropic 协议：需要显式 cache_control 断点（本仓库 anthropicModel 会打 ≤4 个，本探针不走该协议）。',
  );
  console.log('  6. 若端点确实不支持缓存，用 --allow-zero 显式豁免本探针（默认不豁免）。');
  process.exitCode = opts.allowZero ? 0 : 1;
  if (opts.allowZero) {
    console.log('（--allow-zero 已显式豁免：exit 0，但「缓存未命中」这一事实仍然成立。）');
  }
}

/**
 * 模拟两轮结果（干跑，不联网）：用于验证失败路径与退出码语义。
 * @returns {{round1: object, round2: object}} 两轮模拟结果
 */
function simulatedRounds() {
  const round1 = {
    promptTokens: 940,
    cachedPromptTokens: 0,
    completionTokens: 1,
    text: '（模拟）',
    raw: { prompt_tokens: 940, prompt_cache_hit_tokens: 0 },
  };
  const round2 = {
    promptTokens: 946,
    cachedPromptTokens: 0,
    completionTokens: 1,
    text: '（模拟）',
    raw: { prompt_tokens: 946, prompt_cache_hit_tokens: 0 },
  };
  return { round1, round2 };
}

/** 主流程。 */
async function main() {
  const allowZero = process.argv.includes('--allow-zero');
  const simulate = process.argv.includes('--simulate');
  const apiKey =
    envOf('DEEPSEEK_API_KEY', 'OMNIHARNESS_API_KEY') ??
    envOf('OPENAI_API_KEY', 'OMNIHARNESS_API_KEY');
  const baseUrl = envOf('DEEPSEEK_BASE_URL', 'OMNIHARNESS_BASE_URL') ?? 'https://api.deepseek.com';
  const model = envOf('DEEPSEEK_MODEL', 'OMNIHARNESS_MODEL') ?? 'deepseek-chat';
  const url = completionsUrl(baseUrl);
  const configuredDelay = Number(envOne('OMNI_CACHE_PROBE_DELAY_MS') ?? '1500');
  const delayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 1500;
  const { path: prefixPath, text: prefix } = readPrefix();

  console.log('=== 提示缓存真机两轮探针 ===');
  console.log(`端点   : ${url}`);
  console.log(`模型   : ${model}`);
  console.log(`前缀   : ${prefixPath}（${prefix.length} 字符 ≈ ${roughTokens(prefix)} token）`);
  console.log(`两轮间隔: ${delayMs} ms`);
  if (simulate) console.log('模式   : --simulate（干跑，不联网；仅验证失败路径与退出码）');
  console.log('');

  if (simulate) {
    const { round1, round2 } = simulatedRounds();
    reportAndVerdict(round1, round2, { allowZero, delayMs: 0, prefix, ms1: 0, ms2: 0 });
    return;
  }

  if (apiKey === undefined) {
    console.error('[cache-probe] 未找到凭据：请设置 DEEPSEEK_API_KEY 或 OMNIHARNESS_API_KEY。');
    console.error('[cache-probe] 本机可用：node --env-file=.env evals/cache-probe.mjs');
    process.exitCode = 3;
    return;
  }

  // 两轮共享同一 system + 同一 user 前缀（逐字节相同），第二轮只在**末尾追加**。
  const system = '你是一个只输出极简回答的助手。只回答用户最后一句话要求的内容。';
  const base = [
    { role: 'system', content: system },
    { role: 'user', content: `以下是一份仓库源文件，请先记住它：\n\n\`\`\`\n${prefix}\n\`\`\`` },
  ];
  const firstMessages = [...base, { role: 'user', content: '只回答两个字：收到。' }];
  const secondMessages = [
    ...base,
    { role: 'assistant', content: '收到。' },
    { role: 'user', content: '再回答两个字：好的。' },
  ];

  const cfg = { url, apiKey, model, maxTokens: 16 };
  const t0 = Date.now();
  const round1 = await callOnce({ ...cfg, messages: firstMessages }, '第 1 轮');
  const t1 = Date.now();
  await new Promise((done) => setTimeout(done, delayMs));
  const round2 = await callOnce({ ...cfg, messages: secondMessages }, '第 2 轮');
  const t2 = Date.now();

  reportAndVerdict(round1, round2, {
    allowZero,
    delayMs,
    prefix,
    ms1: t1 - t0,
    ms2: t2 - t1 - delayMs,
  });
}

await main();
