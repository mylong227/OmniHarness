#!/usr/bin/env node
// 真实 LLM live 跑分脚手架（OmniHarness）。
//
// 用途：用真实编码模型（DeepSeek / OpenAI 兼容端点）跑一组真实编码任务，
//       产出 steps / tool_calls / token 用量 / 成功率 指标，验证「真实碾压」主张。
//
// 复用 src/eval/evalHarness.ts 的 runTask（已支持注入真实 ModelPort）。
// 本脚本不做任何 mock：无密钥则明确报错并给出设置指引（exit 1），绝不伪造跑分。
//
// U5 升级：任务集从 3 扩展到 12+（含可运行测试验证：expect.run 要求测试真正变绿），
//          新增 --repeat / --pass-k / --min-pass-rate / --min-pass-k 支持 Pass@k 规模化门禁。
//
// 用法：
//   node evals/live/bench.mjs                       # 默认任务集，每任务 1 次采样
//   node evals/live/bench.mjs --repeat 3           # 每任务 3 次采样，计算 Pass@k
//   node evals/live/bench.mjs --pass-k 3           # 打印 Pass@3
//   node evals/live/bench.mjs --min-pass-rate 0.8  # 通过率<0.8 则 exit 非 0（CI 门禁）
//   node evals/live/bench.mjs --suite mySuite.json  # 加载自定义任务集
//   node evals/live/bench.mjs --model deepseek-chat --base-url https://api.deepseek.com/v1 --api-key $KEY
//
// 环境变量（优先级低于同名 --flag）：
//   OMNIHARNESS_API_KEY / OMNIHARNESS_BASE_URL / OMNIHARNESS_MODEL
//   DEEPSEEK_API_KEY    / DEEPSEEK_BASE_URL
//   OPENAI_API_KEY      / OPENAI_BASE_URL

import { rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SWEBENCH_LITE_TASKS,
  buildEnhancedTasks,
  toEvalTask,
} from '../../benchmark/swebenchTasks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DIST = join(ROOT, 'dist', 'src');

/** 跨平台安全动态导入：Windows 下必须转 file:// URL。 */
function importDist(...segments) {
  return import(pathToFileURL(join(DIST, ...segments)).href);
}

const { runTask } = await importDist('eval', 'evalHarness.js');
const { OpenAiCompatibleModel } = await importDist('adapters', 'model', 'openaiCompatibleModel.js');
const { summarizePassK, passKGate } = await importDist('eval', 'passK.js');

/** 解析 --flag 或返回 undefined。 */
function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 解析数字 flag（含缺省）。 */
function numFlag(name, dflt) {
  const v = flag(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 解析配置：flag > OMNIHARNESS_* > DEEPSEEK_* > OPENAI_*。缺密钥返回 { error }。 */
function resolveConfig() {
  const apiKey =
    flag('--api-key') ??
    process.env.OMNIHARNESS_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.OPENAI_API_KEY;
  const baseUrl =
    flag('--base-url') ??
    process.env.OMNIHARNESS_BASE_URL ??
    process.env.DEEPSEEK_BASE_URL ??
    process.env.OPENAI_BASE_URL;
  const model =
    flag('--model') ??
    process.env.OMNIHARNESS_MODEL ??
    process.env.DEEPSEEK_MODEL ??
    'deepseek-chat';

  if (!apiKey) {
    return {
      error: [
        '✋ 未检测到模型密钥，live 跑分无法运行（本脚手架不伪造任何 mock 结果）。',
        '',
        '请设置以下环境变量之一后重试：',
        '  export OMNIHARNESS_API_KEY=sk-xxxx        # 推荐：统一入口',
        '  export OMNIHARNESS_BASE_URL=https://api.deepseek.com/v1',
        '  export OMNIHARNESS_MODEL=deepseek-chat',
        '',
        '  # 或 DeepSeek 直连',
        '  export DEEPSEEK_API_KEY=sk-xxxx',
        '  export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1',
        '',
        '  # 或 OpenAI 兼容端点',
        '  export OPENAI_API_KEY=sk-xxxx',
        '',
        '也可行内传参：node evals/live/bench.mjs --api-key $KEY --base-url https://api.deepseek.com/v1 --model deepseek-chat',
        '',
        '注意：DeepSeek / OpenAI 兼容端点要求 OPENAI 风格 /v1 路径；base-url 须以 /v1 结尾。',
      ].join('\n'),
    };
  }

  const resolvedBaseUrl =
    baseUrl ??
    (model.includes('deepseek') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1');
  return { apiKey, baseUrl: resolvedBaseUrl, model };
}

/** 构造一个「测试须变绿」修复任务。 */
function fixTask(id, description, srcFile, buggySrc, testSrc, marker) {
  return {
    id,
    description,
    prompt: `工作区的 ${srcFile} 有 bug 或缺失实现，导致其单元测试 ${testSrc} 失败。请阅读并修复 ${srcFile}，使 \`node ${testSrc}\` 以退出码 0 通过。只改 ${srcFile}，不要改测试。`,
    seedFiles: { [srcFile]: buggySrc, [testSrc]: testSrc },
    expect: { files: { [srcFile]: marker }, run: { cmd: `node ${testSrc}` } },
  };
}

/** 默认真实编码任务集（自包含：seedFiles 预置到临时工作区）。12 个任务，可运行测试验证。 */
function defaultTasks() {
  return [
    {
      id: 'reverse-string',
      description: '写并验证一个字符串反转函数',
      prompt:
        '在工作区创建 reverse.mjs，导出函数 reverseString(s) 反转字符串；创建 test.mjs 用 node:assert 校验 reverseString("hello")==="olleh"，运行 node test.mjs 应通过。',
      seedFiles: {
        'test.mjs':
          "import assert from 'node:assert';\nimport { reverseString } from './reverse.mjs';\nassert.equal(reverseString('hello'), 'olleh');\nassert.equal(reverseString(''), '');\nconsole.log('ok');\n",
      },
      expect: {
        files: { 'reverse.mjs': 'export function reverseString' },
        run: { cmd: 'node test.mjs' },
      },
    },
    {
      id: 'doc-readme',
      description: '为已有代码生成 README',
      prompt: '阅读工作区的 calculator.ts，创建 README.md 简述其公开 API 与用法。',
      seedFiles: {
        'calculator.ts':
          'export function add(a: number, b: number): number { return a + b; }\nexport function mul(a: number, b: number): number { return a * b; }\n',
      },
      expect: { files: { 'README.md': 'calculator' }, tools: ['read_file', 'write_file'] },
    },
    fixTask(
      'fix-off-by-one',
      '修复 off-by-one bug',
      'sum.mjs',
      'export function sumToN(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) s += i;\n  return s;\n}\n',
      "import assert from 'node:assert';\nimport { sumToN } from './sum.mjs';\nassert.equal(sumToN(5), 15);\nassert.equal(sumToN(1), 1);\nconsole.log('ok');\n",
      'export function sumToN',
    ),
    fixTask(
      'sum-array',
      '实现数组求和',
      'sumArr.mjs',
      'export function sumArr(arr) {\n  return 0;\n}\n',
      "import assert from 'node:assert';\nimport { sumArr } from './sumArr.mjs';\nassert.equal(sumArr([1, 2, 3]), 6);\nassert.equal(sumArr([]), 0);\nconsole.log('ok');\n",
      'export function sumArr',
    ),
    fixTask(
      'capitalize-words',
      '实现单词首字母大写',
      'cap.mjs',
      'export function capitalizeWords(s) {\n  return s;\n}\n',
      "import assert from 'node:assert';\nimport { capitalizeWords } from './cap.mjs';\nassert.equal(capitalizeWords('hello world'), 'Hello World');\nconsole.log('ok');\n",
      'export function capitalizeWords',
    ),
    fixTask(
      'is-palindrome',
      '实现回文判断',
      'pal.mjs',
      'export function isPalindrome(s) {\n  return false;\n}\n',
      "import assert from 'node:assert';\nimport { isPalindrome } from './pal.mjs';\nassert.equal(isPalindrome('racecar'), true);\nassert.equal(isPalindrome('abc'), false);\nconsole.log('ok');\n",
      'export function isPalindrome',
    ),
    fixTask(
      'count-vowels',
      '实现元音计数',
      'vowel.mjs',
      'export function countVowels(s) {\n  return 0;\n}\n',
      "import assert from 'node:assert';\nimport { countVowels } from './vowel.mjs';\nassert.equal(countVowels('aeiou'), 5);\nassert.equal(countVowels('bcdfg'), 0);\nconsole.log('ok');\n",
      'export function countVowels',
    ),
    fixTask(
      'find-max',
      '实现数组最大值',
      'max.mjs',
      'export function findMax(arr) {\n  return 0;\n}\n',
      "import assert from 'node:assert';\nimport { findMax } from './max.mjs';\nassert.equal(findMax([3, 9, 2]), 9);\nassert.equal(findMax([-1, -5, -2]), -1);\nconsole.log('ok');\n",
      'export function findMax',
    ),
    fixTask(
      'flatten-array',
      '实现一层数组扁平化',
      'flat.mjs',
      'export function flatten(arr) {\n  return arr;\n}\n',
      "import assert from 'node:assert';\nimport { flatten } from './flat.mjs';\nassert.deepEqual(flatten([[1, 2], [3]]), [1, 2, 3]);\nconsole.log('ok');\n",
      'export function flatten',
    ),
    fixTask(
      'is-anagram',
      '实现变位词判断',
      'anag.mjs',
      'export function isAnagram(a, b) {\n  return false;\n}\n',
      "import assert from 'node:assert';\nimport { isAnagram } from './anag.mjs';\nassert.equal(isAnagram('listen', 'silent'), true);\nassert.equal(isAnagram('abc', 'def'), false);\nconsole.log('ok');\n",
      'export function isAnagram',
    ),
    fixTask(
      'longest-word',
      '实现最长单词提取',
      'longest.mjs',
      'export function longestWord(s) {\n  return "";\n}\n',
      "import assert from 'node:assert';\nimport { longestWord } from './longest.mjs';\nassert.equal(longestWord('the quick brown'), 'quick');\nconsole.log('ok');\n",
      'export function longestWord',
    ),
    fixTask(
      'fizzbuzz',
      '实现 fizzbuzz',
      'fb.mjs',
      'export function fizzbuzz(n) {\n  return [];\n}\n',
      "import assert from 'node:assert';\nimport { fizzbuzz } from './fb.mjs';\nconst r = fizzbuzz(5);\nassert.equal(r[0], '1');\nassert.equal(r[2], 'fizz');\nassert.equal(r[4], 'buzz');\nconsole.log('ok');\n",
      'export function fizzbuzz',
    ),
  ];
}

/** 加载 --suite JSON（最小校验：tasks 数组）。 */
function loadSuite(path) {
  if (!existsSync(path)) throw new Error(`套件文件不存在: ${path}`);
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(obj.tasks)) throw new Error(`套件格式错误（缺少 tasks 数组）: ${path}`);
  return obj.tasks;
}

/**
 * 加载 SWE-bench Verified 风格子集（联网/本地两路，fail-closed）：
 *   - pathOrUrl 为本地 .jsonl 路径且存在 → 读本地文件解析（离线可用）；
 *   - pathOrUrl 为 http(s) URL 或字面量 'remote' → 经 HF_ENDPOINT（默认 hf-mirror.com）联网拉取；
 *   - 离线 / 无网 / 拉取失败 → 抛错并提示改用 --swebench 本地零 key 子集。
 */
async function loadSwebenchRemote(pathOrUrl) {
  const isUrl = /^https?:\/\//i.test(pathOrUrl) || pathOrUrl === 'remote';
  if (!isUrl) {
    if (!existsSync(pathOrUrl)) throw new Error(`SWE-bench 子集文件不存在: ${pathOrUrl}`);
    return parseSwebenchLiteJsonl(readFileSync(pathOrUrl, 'utf8'));
  }
  const endpoint = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
  const url =
    pathOrUrl === 'remote'
      ? `${endpoint}/datasets/omniharness/swebench-verified-lite/resolve/main/swebench-verified-lite.jsonl`
      : pathOrUrl;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `联网拉取 SWE-bench 子集失败（离线环境？）：${err instanceof Error ? err.message : err}\n  请用 --swebench 加载本地零 key 子集。`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `联网拉取 SWE-bench 子集 HTTP ${res.status}: ${url}\n  请用 --swebench 加载本地零 key 子集。`,
    );
  }
  return parseSwebenchLiteJsonl(await res.text());
}

/** 解析 SWE-bench lite 子集 jsonl（每行一条 SweTask 形状）→ EvalTask[]。 */
function parseSwebenchLiteJsonl(text) {
  const tasks = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    tasks.push(toEvalTask(JSON.parse(t)));
  }
  if (tasks.length === 0) throw new Error('SWE-bench 子集为空');
  return tasks;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      '用法: node evals/live/bench.mjs [--swebench] [--swebench-remote <path|url|remote>] [--suite path.json] [--repeat N] [--pass-k K] [--min-pass-rate R] [--min-pass-k K,R] [--model m] [--base-url u] [--api-key k]',
    );
    return;
  }

  const useSwebench = process.argv.includes('--swebench');
  const swebenchRemote = flag('--swebench-remote');

  // 任务集选择（优先级）：--swebench(本地零 key 子集) > --swebench-remote(联网/本地两路) > --suite > 默认 live 集。
  let tasks;
  if (useSwebench) {
    tasks = buildEnhancedTasks(SWEBENCH_LITE_TASKS).map(toEvalTask);
    console.log('（SWE-bench 本地子集：ScriptedModel replay 零 key 跑 Pass@k 规模化）');
  } else if (swebenchRemote !== undefined) {
    tasks = await loadSwebenchRemote(swebenchRemote);
  } else if (flag('--suite')) {
    tasks = loadSuite(flag('--suite'));
  } else {
    tasks = defaultTasks();
  }

  // live 模型仅在非 SWE-bench 模式需要（SWE-bench 用 ScriptedModel replay，零 key）。
  let model;
  if (!useSwebench && swebenchRemote === undefined) {
    const cfg = resolveConfig();
    if (cfg.error) {
      console.error(cfg.error);
      process.exit(1);
    }
    model = new OpenAiCompatibleModel({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    });
  }

  const repeat = Math.max(1, Math.floor(numFlag('--repeat', 1)));
  const passKTarget = Math.max(1, Math.floor(numFlag('--pass-k', 1)));
  const minPassRate =
    flag('--min-pass-rate') !== undefined ? Number(flag('--min-pass-rate')) : undefined;
  const minPassKReq = parseMinPassK(flag('--min-pass-k'));

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-live-'));

  const modelLabel =
    useSwebench || swebenchRemote !== undefined ? 'scripted(SWE-bench 零 key)' : cfg.model;
  const endpointLabel = useSwebench || swebenchRemote !== undefined ? 'n/a' : cfg.baseUrl;
  console.log(`=== OmniHarness Live 跑分 (U5 规模化) ===`);
  console.log(
    `模型: ${modelLabel} 端点: ${endpointLabel} 任务数: ${tasks.length} 每任务采样: ${repeat}\n`,
  );

  // 每任务多次采样结果（Pass@k 用）。
  const taskSamples = new Map();
  const perTaskSummary = [];

  try {
    for (const task of tasks) {
      const samples = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalDurationMs = 0;
      let totalSteps = 0;
      for (let r = 0; r < repeat; r++) {
        const t0 = Date.now();
        try {
          const res = await runTask(task, workspaceRoot, model);
          const dt = Date.now() - t0;
          samples.push(res.passed);
          totalDurationMs += dt;
          totalSteps += res.steps;
          if (res.usage) {
            totalPromptTokens += res.usage.promptTokens;
            totalCompletionTokens += res.usage.completionTokens;
          }
          const mark = res.passed ? '✅' : '❌';
          const repTag = repeat > 1 ? `[#${r + 1}] ` : '';
          const usageStr = res.usage
            ? `tokens=${res.usage.totalTokens}(in:${res.usage.promptTokens}/out:${res.usage.completionTokens})`
            : 'tokens=n/a';
          console.log(
            `${repTag}${mark} ${res.id}  steps=${res.steps}  tools=[${res.toolCalls.join(', ')}]  ${dt}ms  ${usageStr}`,
          );
          if (!res.passed) for (const reason of res.reasons) console.log(`     - ${reason}`);
        } catch (err) {
          const dt = Date.now() - t0;
          totalDurationMs += dt;
          const msg = err instanceof Error ? err.message : String(err);
          samples.push(false);
          console.log(`❌ ${task.id}  运行异常: ${msg}`);
        }
      }
      taskSamples.set(task.id, samples);
      const passCount = samples.filter(Boolean).length;
      perTaskSummary.push({
        id: task.id,
        pass: passCount,
        total: samples.length,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        durationMs: totalDurationMs,
        steps: totalSteps,
      });
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  // Pass@k 汇总（仅 when repeat>1 才有意义；repeat=1 时 passAtK[0]=通过率）。
  const outcomes = [...taskSamples.values()];
  const summary = summarizePassK(outcomes, Math.max(passKTarget, 1));
  const passedTasks = perTaskSummary.filter((t) => t.pass === t.total).length;
  const totalPrompt = perTaskSummary.reduce((s, t) => s + t.promptTokens, 0);
  const totalCompletion = perTaskSummary.reduce((s, t) => s + t.completionTokens, 0);
  const totalDuration = perTaskSummary.reduce((s, t) => s + t.durationMs, 0);
  const totalSteps = perTaskSummary.reduce((s, t) => s + t.steps, 0);

  console.log('\n--- 汇总 ---');
  console.log(`任务全过: ${passedTasks}/${perTaskSummary.length}`);
  console.log(`总通过率: ${(summary.meanPassRate * 100).toFixed(1)}%`);
  if (repeat > 1) {
    console.log(
      `Pass@1: ${summary.passAtK[0]?.toFixed(3)}  Pass@${passKTarget}: ${summary.passAtK[passKTarget - 1]?.toFixed(3)}`,
    );
  }
  console.log(`总步数: ${totalSteps}`);
  console.log(
    `总 token: ${totalPrompt + totalCompletion} (prompt:${totalPrompt} / completion:${totalCompletion})`,
  );
  console.log(`总采样: ${summary.totalSamples}  总耗时: ${totalDuration}ms`);

  // fail-closed 门禁判定。
  const gate = passKGate(summary, {
    minPassRate: minPassRate ?? (repeat > 1 ? undefined : 1),
    minPassK: minPassKReq,
  });
  if (!gate.passed) {
    console.log('\n❌ 门禁未达标:');
    for (const f of gate.failures) console.log(`   - ${f}`);
    process.exit(2);
  }
  if (minPassRate !== undefined || minPassKReq.length > 0) {
    console.log('\n✅ 门禁达标');
  }
  process.exit(0);
}

/** 解析 --min-pass-k "3,0.8;5,0.9" → [{k,threshold}]。 */
function parseMinPassK(raw) {
  if (raw === undefined) return [];
  const out = [];
  for (const part of raw.split(';')) {
    const [k, thr] = part.split(',');
    const kk = Number(k);
    const tt = Number(thr);
    if (Number.isFinite(kk) && Number.isFinite(tt)) out.push({ k: kk, threshold: tt });
  }
  return out;
}

main().catch((err) => {
  console.error('live 跑分异常:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
