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
// T4.7 升级：新增 --min-pass-k-ci / --ci / --ci-rounds，用**确定性 bootstrap 95% 区间**判
//           Pass@k——点阈值在边界会随机红/绿，区间判定三态（达标/显著不达标/样本不足）且可复现。
// T4.6/T4.2/T5.5 接线（本轮）：每次采样走 `runTaskIsolated`（评测只吃冻结快照，生成方后续写操作
//           进不了 verdict）；每个任务在「补丁应用前 / 后」各取一次工作区指纹快照喂 `EditDriftDetector`
//           （oscillation / thrash 告警 → 控制台 + --max-drift-alarms 退出码闸）；按 `ReasoningRouter`
//           的难度分层给模型请求设 reasoning effort（易 low / 中 medium / 难 high）。
//
// 用法：
//   node evals/live/bench.mjs                       # 默认任务集，每任务 1 次采样
//   node evals/live/bench.mjs --repeat 3           # 每任务 3 次采样，计算 Pass@k
//   node evals/live/bench.mjs --pass-k 3           # 打印 Pass@3
//   node evals/live/bench.mjs --min-pass-rate 0.8  # 通过率<0.8 则 exit 非 0（CI 门禁）
//   node evals/live/bench.mjs --repeat 5 --min-pass-k-ci 3,0.9  # 区间下界<0.9 则红（T4.7）
//   node evals/live/bench.mjs --max-drift-alarms 0 # 反漂移告警>0 即 exit 非 0（T4.2）
//   node evals/live/bench.mjs --suite mySuite.json  # 加载自定义任务集
//   node evals/live/bench.mjs --model deepseek-chat --base-url https://api.deepseek.com/v1 --api-key $KEY
//
// 环境变量（优先级低于同名 --flag）：
//   OMNIHARNESS_API_KEY / OMNIHARNESS_BASE_URL / OMNIHARNESS_MODEL
//   DEEPSEEK_API_KEY    / DEEPSEEK_BASE_URL
//   OPENAI_API_KEY      / OPENAI_BASE_URL

import { rmSync, mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readUserProviderKey } from '../../dist/src/eval/liveCredentials.js';
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

const { runTaskIsolated } = await importDist('eval', 'evalHarness.js');
const { OpenAiCompatibleModel } = await importDist('adapters', 'model', 'openAiCompatibleModel.js');
const { summarizePassK, passKGate, bootstrapPassK, passKGateWithCI } = await importDist(
  'eval',
  'passK.js',
);
// T4.7：固定种子由 bootstrap 模块导出——打印它即证明区间门禁跑的就是种子化重采样实现。
const { DEFAULT_BOOTSTRAP_SEED } = await importDist('eval', 'bootstrap.js');
// T5.5：难度分层推理强度路由（易 low / 中 medium / 难 high）。
const { ReasoningRouter } = await importDist('eval', 'reasoningRouter.js');
// T4.2：反漂移检测（同文件反复改的 oscillation / thrash）。
const { EditDriftDetector } = await importDist('eval', 'editDriftDetector.js');

/** 快照工作区文件指纹（补丁应用前 / 后两端；跳过依赖与构建目录）。 */
function snapshotWorkspace(root) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target']);
  const snapshot = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      continue; // 采集期目录消失（并发写）→ 跳过
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const content = readFileSync(join(root, child), 'utf8');
        snapshot.set(child, createHash('sha1').update(content, 'utf8').digest('hex'));
      } catch {
        // 采集期文件消失 → 跳过
      }
    }
  }
  return snapshot;
}

/** 比较前后两次指纹快照，把差异喂给反漂移检测器并返回命中的告警。 */
function recordDrift(detector, before, after) {
  const alarms = [];
  for (const [file, revision] of after) {
    if (before.get(file) === revision) continue;
    const alarm = detector.record({ file, revision });
    if (alarm !== undefined) alarms.push(alarm);
  }
  return alarms;
}

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
  // 凭据分层纪律：env 缺失时回退用户级配置 ~/.omniharness/omniharness.json（仓库树不放密钥）。
  const apiKey =
    flag('--api-key') ??
    process.env.OMNIHARNESS_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.OPENAI_API_KEY ??
    readUserProviderKey();
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

/**
 * 构造一个「测试须变绿」修复任务。
 *
 * 参数次序（与本文件 10 个调用点一致）：`(id, description, srcFile, buggySrc, testSrc, marker)`，
 * 其中 `testSrc` 是**测试文件的内容**，测试文件名统一取 `test.mjs`（与 `reverse-string` 任务同约定）。
 *
 * 为什么要点明这一点：原实现把第 5 个参数**同时**当文件名与文件内容用
 * （`seedFiles: { [srcFile]: buggySrc, [testSrc]: testSrc }`、`run.cmd = 'node <测试源码>'`）——
 * 于是生成阶段拿**测试源码当目录名**去 `mkdir`，live 路径必然 `ENOENT`。这个错误长期没暴露，
 * 因为 CI 里跑的一直是零 key 的 `--swebench` scripted 路径，根本不经过 `fixTask`。
 */
function fixTask(id, description, srcFile, buggySrc, testSrc, marker) {
  const testFile = 'test.mjs';
  return {
    id,
    description,
    prompt: `工作区的 ${srcFile} 有 bug 或缺失实现，导致其单元测试 ${testFile} 失败。请阅读并修复 ${srcFile}，使 \`node ${testFile}\` 以退出码 0 通过。只改 ${srcFile}，不要改测试。`,
    seedFiles: { [srcFile]: buggySrc, [testFile]: testSrc },
    expect: { files: { [srcFile]: marker }, run: { cmd: `node ${testFile}` } },
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
      '用法: node evals/live/bench.mjs [--swebench] [--swebench-remote <path|url|remote>] [--suite path.json] [--repeat N] [--pass-k K] [--min-pass-rate R] [--min-pass-k K,R] [--min-pass-k-ci K,R] [--ci] [--ci-rounds N] [--max-drift-alarms N] [--model m] [--base-url u] [--api-key k]',
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
  //
  // 注意：`cfg` 必须声明在**外层作用域**。原先它声明在 if 块内，而下面的模型/端点标签行使三元读
  // `cfg.model` / `cfg.baseUrl`——scripted 路径因三元**短路**永不求值，所以这个 ReferenceError
  // 只在真正的 live 路径上炸（`node evals/live/bench.mjs` 直接 `ReferenceError: cfg is not defined`），
  // 长期没暴露：CI 里跑的一直是零 key 的 scripted 子集。
  const liveMode = !useSwebench && swebenchRemote === undefined;
  const cfg = liveMode ? resolveConfig() : undefined;
  if (cfg !== undefined && cfg.error) {
    console.error(cfg.error);
    process.exit(1);
  }
  const model =
    cfg === undefined
      ? undefined
      : new OpenAiCompatibleModel({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
        });

  const repeat = Math.max(1, Math.floor(numFlag('--repeat', 1)));
  const passKTarget = Math.max(1, Math.floor(numFlag('--pass-k', 1)));
  const minPassRate =
    flag('--min-pass-rate') !== undefined ? Number(flag('--min-pass-rate')) : undefined;
  const minPassKReq = parseMinPassK(flag('--min-pass-k'));
  const minPassKCiReq = parseMinPassK(flag('--min-pass-k-ci'));
  const ciRounds = Math.max(1, Math.floor(numFlag('--ci-rounds', 2000)));
  // T4.2：反漂移闸上限（缺省 Infinity = 只报告不拦截；给值即成为退出码闸）。
  const maxDriftRaw = numFlag('--max-drift-alarms', Number.POSITIVE_INFINITY);
  const maxDriftAlarms = Number.isFinite(maxDriftRaw) ? maxDriftRaw : Number.POSITIVE_INFINITY;

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-live-'));

  // T5.5：按任务难度分层路由推理强度（确定性规则；同输入恒同档位）。
  const router = new ReasoningRouter();
  const routedEffort = new Map(tasks.map((task) => [task.id, router.route(task.prompt)]));
  const routingBudget = router.compareBudgets(tasks.map((task) => task.prompt));
  // T4.2：反漂移检测器跨任务共享（同一工作区被反复改同一文件才是要抓的信号）。
  const driftDetector = new EditDriftDetector();

  const modelLabel = liveMode ? cfg.model : 'scripted(SWE-bench 零 key)';
  const endpointLabel = liveMode ? cfg.baseUrl : 'n/a';
  console.log(`=== OmniHarness Live 跑分 (U5 规模化) ===`);
  console.log(
    `模型: ${modelLabel} 端点: ${endpointLabel} 任务数: ${tasks.length} 每任务采样: ${repeat}\n`,
  );
  const effortCounts = { low: 0, medium: 0, high: 0 };
  for (const effort of routedEffort.values()) effortCounts[effort] += 1;
  console.log(
    `推理强度路由（T5.5）：low=${effortCounts.low} medium=${effortCounts.medium} high=${effortCounts.high}` +
      `（一刀切 high 预算 ${routingBudget.fixedTotal} → 路由后 ${routingBudget.routedTotal}，Δ=${routingBudget.delta}）`,
  );
  console.log('反漂移检测（T4.2）：每个任务在补丁应用前后各取指纹快照，命中即告警\n');

  // 每任务多次采样结果（Pass@k 用）。
  const taskSamples = new Map();
  const perTaskSummary = [];
  const driftAlarms = [];
  let isolatedSamples = 0;

  try {
    for (const task of tasks) {
      const samples = [];
      const effort = routedEffort.get(task.id);
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalDurationMs = 0;
      let totalSteps = 0;
      for (let r = 0; r < repeat; r++) {
        const t0 = Date.now();
        const before = snapshotWorkspace(workspaceRoot);
        try {
          const res = await runTaskIsolated(task, workspaceRoot, model, {
            reasoningEffort: effort,
          });
          const alarms = recordDrift(driftDetector, before, snapshotWorkspace(workspaceRoot));
          driftAlarms.push(...alarms);
          const dt = Date.now() - t0;
          samples.push(res.passed);
          totalDurationMs += dt;
          totalSteps += res.steps;
          if (res.isolation !== undefined) isolatedSamples += 1;
          if (res.usage) {
            totalPromptTokens += res.usage.promptTokens;
            totalCompletionTokens += res.usage.completionTokens;
          }
          const mark = res.passed ? '✅' : '❌';
          const repTag = repeat > 1 ? `[#${r + 1}] ` : '';
          const usageStr = res.usage
            ? `tokens=${res.usage.totalTokens}(in:${res.usage.promptTokens}/out:${res.usage.completionTokens})`
            : 'tokens=n/a';
          const isoStr = `effort=${effort ?? 'n/a'} 隔离快照=${res.isolation?.snapshotFiles ?? 0}文件`;
          console.log(
            `${repTag}${mark} ${res.id}  steps=${res.steps}  tools=[${res.toolCalls.join(', ')}]  ${dt}ms  ${usageStr}  ${isoStr}`,
          );
          if (!res.passed) for (const reason of res.reasons) console.log(`     - ${reason}`);
          for (const alarm of alarms) {
            console.log(`     ⚠️ [反漂移·${alarm.kind}] ${alarm.file}: ${alarm.detail}`);
          }
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
  console.log(
    `隔离评测（T4.6）：${isolatedSamples}/${summary.totalSamples} 次采样经冻结快照评测（评测不读生成方活引用）`,
  );
  console.log(`反漂移（T4.2）：告警 ${driftAlarms.length} 条`);
  for (const alarm of driftAlarms) {
    console.log(`   ⚠️ [${alarm.kind}] ${alarm.file}: ${alarm.detail}`);
  }

  // T4.7：区间判定（可选）——点阈值在边界会随机红/绿；区间判定三态且可复现。
  const wantCI = minPassKCiReq.length > 0 || process.argv.includes('--ci');
  let ciGate = null;
  if (wantCI) {
    const maxKForCI = Math.max(passKTarget, ...minPassKCiReq.map((r) => r.k), 1);
    const report = bootstrapPassK(outcomes, maxKForCI, { rounds: ciRounds });
    console.log(
      `\n--- 置信区间（bootstrap 95%，rounds=${ciRounds}，种子固定 seed=0x${DEFAULT_BOOTSTRAP_SEED.toString(16)} ⇒ 可复现）---`,
    );
    for (let k = 1; k <= maxKForCI; k++) {
      const ci = report.passAtKCI[k - 1];
      const pt = report.summary.passAtK[k - 1];
      if (ci === undefined) continue;
      console.log(
        `Pass@${k}: ${pt?.toFixed(3)}  CI=[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]  rounds=${ci.rounds}`,
      );
    }
    console.log(
      `通过率: ${report.meanPassRateCI.mean.toFixed(3)}  CI=[${report.meanPassRateCI.lo.toFixed(3)}, ${report.meanPassRateCI.hi.toFixed(3)}]`,
    );
    ciGate = passKGateWithCI(report, { minPassRate, minPassK: minPassKCiReq });
  }

  // fail-closed 门禁判定（点阈值 + 区间 + 反漂移，任一不达标即红）。
  const gate = passKGate(summary, {
    minPassRate: minPassRate ?? (repeat > 1 ? undefined : 1),
    minPassK: minPassKReq,
  });
  const driftFailed = driftAlarms.length > maxDriftAlarms;
  const failed = !gate.passed || (ciGate !== null && !ciGate.passed) || driftFailed;
  if (failed) {
    console.log('\n❌ 门禁未达标:');
    if (!gate.passed) for (const f of gate.failures) console.log(`   - ${f}`);
    if (ciGate !== null) {
      for (const f of ciGate.failures) console.log(`   - [CI] ${f}`);
      for (const f of ciGate.inconclusive) console.log(`   - [CI·样本不足] ${f}`);
    }
    if (driftFailed) {
      console.log(`   - [反漂移] 告警 ${driftAlarms.length} > 上限 ${maxDriftAlarms}`);
    }
    process.exit(2);
  }
  if (
    minPassRate !== undefined ||
    minPassKReq.length > 0 ||
    ciGate !== null ||
    Number.isFinite(maxDriftAlarms)
  ) {
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
