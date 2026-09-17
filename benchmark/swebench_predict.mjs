// swebench_predict.mjs —— SWE-bench Verified「预测生成」端（agent 侧解题），补齐打分链路的另一半。
//
// 背景：`benchmark/capability_swebench.mjs --verified` 只负责**打分**（predictions.jsonl → pytest → resolved）。
// 本脚本负责另一半：对官方 Verified 实例，把仓库置于 base_commit，用**本仓库自己的检索上下文投送**
// （`RepoMapContextEngine`）组装提示，调模型产出 unified diff，落盘为官方格式的 predictions.jsonl。
//
// 为什么必须用本仓库的检索层而不是随便拼上下文：待验证的问题正是
// 「`RepoMapPayload` 梯度投送把注入 token 压降 60~70%，**下游任务完成率是否同步不退化**」
// （见 `src/context/repoMapPayload.ts` 顶部「诚实边界」——该模块自己声明不作承诺，需端到端基准验证）。
// 故本脚本把 `--payload-shape` 做成旋钮：同一批实例跑 `full` 与 `tiered` 两档，只有投送形态变，
// 其余逐字相同，从而把「省 token 的代价」隔离出来。
//
// 零漂移自证：脚本自己复刻 `getRepoMapContext` 的第一段/第二段/载荷组装（因为需要拿到命中**文件列表**
// 才能读文件正文），并在每个实例上把「复刻产出」与「生产入口产出」**逐字节比对**，不一致即 abort。
// 这样 A/B 与生产行为不可能悄悄分叉。
//
// 用法：
//   node benchmark/swebench_predict.mjs --instances psf__requests-1142,pytest-dev__pytest-5262 \
//     --payload-shape tiered --out /tmp/preds.tiered.jsonl
//   node benchmark/swebench_predict.mjs --repo mwaskom/seaborn --limit 2 \
//     --payload-shape full --out /tmp/preds.full.jsonl
//
// 依赖：需先 `npm run build`（脚本 import dist）。模型凭据从 `.env` 读取。
// 零依赖（仅 node: 内置 + 本仓库 dist）。

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- 参数解析 ----------
/** 取 `--name value` 形式的参数值。
 * @param {string} name 参数名（含前导 --）。
 * @returns {string | undefined} 值；未提供时 undefined。
 */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const opts = {
  verified: arg('--verified') ?? join(ROOT, 'eval-data', 'swe_bench_verified.json'),
  out: arg('--out') ?? join(ROOT, 'eval-data', 'predictions.jsonl'),
  instances: arg('--instances')
    ?.split(',')
    .filter((s) => s.length > 0),
  repo: arg('--repo'),
  instanceList: arg('--instance-list'),
  limit: arg('--limit') !== undefined ? Number(arg('--limit')) : undefined,
  payloadShape: arg('--payload-shape') ?? 'tiered',
  fileK: arg('--file-k') !== undefined ? Number(arg('--file-k')) : undefined,
  contentFiles: arg('--content-files') !== undefined ? Number(arg('--content-files')) : 8,
  contentChars: arg('--content-chars') !== undefined ? Number(arg('--content-chars')) : 10000,
  windowRadius: arg('--window-radius') !== undefined ? Number(arg('--window-radius')) : 60,
  repairRounds: arg('--repair-rounds') !== undefined ? Number(arg('--repair-rounds')) : 2,
  // 默认 0（贪婪解码）：基准要求同输入同输出，否则同一实例多次跑出不同补丁会把 A/B 差异淹没在采样噪声里。
  // 需要观察采样多样性时显式 `--temperature 1`。
  temperature: arg('--temperature') !== undefined ? Number(arg('--temperature')) : 0,
  cacheRoot: arg('--cache-root') ?? join(ROOT, 'eval-data', 'repos'),
  worktreeRoot: arg('--worktree-root') ?? join(ROOT, 'eval-data', 'prepare'),
  repoBaseUrl: arg('--repo-base') ?? 'https://gitee.com/',
  mirrorPath: arg('--repo-mirrors') ?? join(ROOT, 'benchmark', 'swebench-gitee-mirrors.json'),
  dryRun: process.argv.includes('--dry-run'),
  keepWorktree: process.argv.includes('--keep-worktree'),
  dumpDir: arg('--dump-dir'),
};

if (!['full', 'tiered', 'degrade'].includes(opts.payloadShape)) {
  console.error(`❌ --payload-shape 只能是 full|tiered|degrade，收到 ${opts.payloadShape}`);
  process.exit(1);
}

// ---------- .env ----------
/** 极简 .env 解析（零依赖；已存在的进程环境变量优先，不覆盖）。
 * @param {string} path .env 路径。
 * @returns {void}
 */
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv(join(ROOT, '.env'));

// ---------- dist 导入 ----------
const { SwebenchVerified } = await import('../dist/src/eval/swebenchVerified.js');
const { RepoMapContextEngine } = await import('../dist/src/context/repoMapContextEngine.js');
const { CorpusIndexCache } = await import('../dist/src/context/corpusIndexCache.js');
const { query } = await import('../dist/src/context/contextEngine.js');
const { RepoMapPayload } = await import('../dist/src/context/repoMapPayload.js');
const { OpenAiCompatibleModel } =
  await import('../dist/src/adapters/model/openaiCompatibleModel.js');

/** 生产默认 fileK（与 `repoMapContextEngine.ts` 的 DEFAULT_FILE_K 对齐）。
 * @returns {number} 默认文件预算。 */
const DEFAULT_FILE_K = 20;
const FILE_K = opts.fileK ?? DEFAULT_FILE_K;

const mirrors = existsSync(opts.mirrorPath)
  ? (JSON.parse(readFileSync(opts.mirrorPath, 'utf8')).mirrors ?? {})
  : {};

/** 把上游 slug 转成缓存目录名（与 NativeExecutor 同口径，便于复用克隆缓存）。
 * @param {string} repo 上游 slug。
 * @returns {string} 目录名。 */
const safe = (repo) => repo.replace('/', '__');

/** 确保仓库已克隆进缓存（复用 `NativeExecutor` 的目录布局 ⇒ 打分阶段零重复克隆）。
 * @param {string} repo 上游 slug。
 * @returns {string} 缓存目录路径。
 */
function ensureClone(repo) {
  const dir = join(opts.cacheRoot, safe(repo));
  if (existsSync(dir)) return dir;
  mkdirSync(opts.cacheRoot, { recursive: true });
  const slug = mirrors[repo] ?? repo;
  const url = `${opts.repoBaseUrl}${slug}.git`;
  console.log(`  [clone] ${url} → ${dir}`);
  execFileSync('git', ['clone', url, dir], { cwd: opts.cacheRoot, stdio: 'inherit' });
  return dir;
}

/** 把缓存克隆 checkout 到 base_commit，返回可读工作区（第二个配置直接复用同一目录）。
 * @param {string} repo 上游 slug。
 * @param {string} base 目标 commit sha。
 * @param {string} instanceId 实例 id（决定工作区目录名）。
 * @returns {string} 工作区路径。
 */
function ensureCheckout(repo, base, instanceId) {
  const cacheDir = ensureClone(repo);
  mkdirSync(opts.worktreeRoot, { recursive: true });
  const wt = join(opts.worktreeRoot, instanceId);
  /** 校验该目录当前 HEAD。
   * @returns {string | null} HEAD sha；不是 git 仓库时 null。 */
  const headOf = () => {
    try {
      // stderr 必须吞掉：目录尚不存在时 git 会往 stderr 打一行 fatal，属预期路径而非错误。
      return execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  if (headOf() === base) return wt;
  // 已有但停在别的 commit：清掉重来，避免半清理状态。
  // 容错：并发/中断可能让 `worktree remove --force` 失败（如工作树被锁或元数据不一致），
  // 此时退化为直接删目录 + prune，避免单实例把整批拖垮（曾因与另一并发跑分进程抢同一工作树而误报失败）。
  if (existsSync(wt)) {
    try {
      execFileSync('git', ['-C', cacheDir, 'worktree', 'remove', '--force', wt], {
        stdio: 'ignore',
      });
    } catch {
      rmSync(wt, { recursive: true, force: true });
      try {
        execFileSync('git', ['-C', cacheDir, 'worktree', 'prune'], { stdio: 'ignore' });
      } catch {
        /* 忽略：prune 失败不影响后续 worktree add */
      }
    }
  }
  // 确保 base_commit 在本地对象库（浅克隆/缓存不全时补取）。
  try {
    execFileSync('git', ['-C', cacheDir, 'cat-file', '-e', base], { stdio: 'ignore' });
  } catch {
    console.log('  [fetch] 缓存缺 base_commit，补取…');
    execFileSync('git', ['-C', cacheDir, 'fetch', '--all'], { stdio: 'inherit' });
  }
  execFileSync('git', ['-C', cacheDir, 'worktree', 'add', '--detach', wt, base], {
    stdio: 'inherit',
  });
  return wt;
}

// ---------- 检索上下文（复刻生产路径 + 逐字节自证） ----------
/** 复刻 `getRepoMapContext` 的检索与载荷组装，并返回命中文件列表（生产接口只回文本）。
 *
 * 与生产逐字对齐的三处：第一段候选 = `query()` 的 `max(fileBM25, 0.7×symBM25)` 池；
 * 第二段精排由 `query({rerank:true})` 承担；载荷由 `RepoMapPayload.assemble` 按档位组装。
 * @param {import('../dist/src/context/corpusIndexCache.js').CorpusIndexCache} cache 语料缓存。
 * @param {string} root 工作区根。
 * @param {string} q 查询（问题陈述）。
 * @returns {{ text: string, files: readonly string[], symbols: readonly {file: string, line: number, kind: string, name: string}[], tokens: number }} 上下文文本 + 命中文件 + 命中符号 + token。
 */
function retrieve(cache, root, q) {
  const corpus = cache.get(root);
  if (corpus === null) throw new Error('语料索引失败');
  const res = query(corpus, q, {
    graph: false,
    lsa: false,
    layered: false,
    fileK: FILE_K,
    symK: 24,
    rerank: process.env.OMNI_RERANK !== '0',
    prf: process.env.OMNI_RM3 === '1',
  });
  const plan =
    opts.payloadShape === 'full'
      ? null
      : opts.payloadShape === 'degrade'
        ? RepoMapPayload.DEGRADE_PLAN
        : RepoMapPayload.DEFAULT_PLAN;
  const text = RepoMapPayload.assemble(
    { corpus, files: res.files, symbols: res.symbols, query: q },
    plan,
  );
  return { text, files: res.files, symbols: res.symbols, tokens: res.tokens };
}

// ---------- 提示组装 ----------
/**
 * 读取「文件头 + 指定行窗口」的内容块（真实 agent 的读法：不按字符数从头硬截）。
 *
 * 为什么必须这样做（首跑实测教训）：`requests/models.py` 共 658 行 / 20789 字符，而补丁目标在
 * 第 386 行（字符偏移 12066）——朴素的「从头截 10000 字符」把它切掉了，模型看不到要改的那段，
 * 于是只能凭空编造上下文（写出仓库里不存在的 `super_len`），补丁必然应用失败。
 * repo-map 恰好给了**符号所在行号**，据此开窗即可精确命中，这也是检索层真正的用途：
 * 不是替模型读代码，而是告诉它**该读哪里**。
 * @param {string} wt 工作区根。
 * @param {string} rel 仓库内相对路径。
 * @param {readonly number[]} lines 关注行号（1-based；空数组 = 只给文件头）。
 * @param {number} radius 窗口半径（行）。
 * @param {number} maxChars 本块字符上限。
 * @returns {string | null} 内容块文本；不可读时 null。
 */
function readWindowBlock(wt, rel, lines, radius, maxChars) {
  const abs = join(wt, rel);
  if (!abs.startsWith(wt)) return null;
  let all;
  try {
    all = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const src = all.split('\n');
  if (all.length <= maxChars) return all; // 短文件：整份给出，信息最大化且零歧义

  // 合并重叠窗口（按行号升序、相邻即并）。
  const spans = [];
  for (const ln of [...lines].sort((a, b) => a - b)) {
    const start = Math.max(1, ln - radius);
    const end = Math.min(src.length, ln + radius);
    const last = spans[spans.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }

  // ★顺序不可颠倒：**窗口优先、文件头吃剩余预算**。
  // 早期实现先塞文件头、再用 `if (body.length + used > maxChars) continue` 兜窗口，结果是
  // 「文档字符串多的大文件 ⇒ 窗口静默被丢，只剩文件头」——模型看不到要改的那段，只能凭记忆编造
  // （flask 实测：head 63 行吃掉预算后，第 184 行的窗口被丢弃 ⇒ 三轮改不对）。
  // 窗口是补丁必然落在的地方，其价值远高于文件头，故必须优先且**截断而非丢弃**。
  const parts = [];
  let used = 0;
  for (const sp of spans) {
    const room = maxChars - used - 1200; // 给文件头预留配额
    if (room < 400) break;
    let body = src.slice(sp.start - 1, sp.end).join('\n');
    if (body.length > room) body = `${body.slice(0, room)}\n... [window truncated]`;
    used += body.length;
    parts.push(`# ${rel} — lines ${sp.start}-${sp.end}`, body, '');
  }

  // 文件头按**实际字符**精确分配，避免「每行 40 字符」估算在宽行文件上溢出预算
  // （自检用例每行 82 字符：旧实现 head 用 floor(headRoom/40) 行数估算会超出 maxChars）。
  const headRoom = maxChars - used;
  if (headRoom > 0) {
    const headPieces = [];
    let hUsed = 0;
    for (let i = 0; i < src.length; i += 1) {
      const ln = src[i];
      const add = ln.length + 1; // +1 为换行符
      if (hUsed + add > headRoom) break;
      headPieces.push(ln);
      hUsed += add;
    }
    if (headPieces.length > 0) {
      const head = headPieces.join('\n');
      parts.unshift(`# ${rel} — head (lines 1-${headPieces.length})`, head, '');
    }
  }
  return parts.join('\n');
}

/**
 * 组装送模型的「相关文件内容」块：优先覆盖 repo-map 命中的符号行（即最可能出补丁的位置）。
 * @param {string} wt 工作区根。
 * @param {readonly string[]} files 命中文件（按检索次序）。
 * @param {readonly {file: string, line: number}[]} symbols 命中符号。
 * @param {{contentFiles: number, contentChars: number, windowRadius: number}} o 选项。
 * @returns {Array<{rel: string, body: string}>} 内容块列表。
 */
function buildContentBlocks(wt, files, symbols, o) {
  const byFile = new Map();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s.line);
  }
  const out = [];
  for (const rel of files.slice(0, o.contentFiles)) {
    const body = readWindowBlock(wt, rel, byFile.get(rel) ?? [], o.windowRadius, o.contentChars);
    if (body !== null) out.push({ rel, body });
  }
  return out;
}

const SYSTEM_PROMPT = [
  'You are a senior Python engineer fixing a real bug in an open-source repository.',
  'You are given the issue report, a repository map listing the most relevant files, and the source of the most relevant files.',
  '',
  'Output rules (strict):',
  '- Output ONLY a unified diff that applies cleanly with `git apply` from the repository root.',
  '- Use `diff --git a/<path> b/<path>` headers, followed by `--- a/<path>`, `+++ b/<path>`, and `@@` hunks.',
  '- Paths must be relative to the repository root and must exist in the repository.',
  '- Do NOT modify any test files (paths under `tests/`, or files starting with `test_`).',
  '- Do NOT wrap the diff in markdown fences and do NOT add any prose, explanation, or summary.',
  '- If you are unsure, still output your best minimal patch.',
].join('\n');

/** 组装单实例的模型请求消息。
 * @param {object} task 归一化 Verified 任务。
 * @param {string} mapText 检索到的 repo-map 上下文。
 * @param {Array<{rel: string, body: string}>} contents 命中文件正文。
 * @returns {Array<{role: string, content: string}>} 消息数组。
 */
function buildMessages(task, mapText, contents) {
  const filesBlock = contents
    .map((c) => `### ${c.rel}\n\`\`\`python\n${c.body}\n\`\`\``)
    .join('\n\n');
  const user = [
    `Repository: ${task.repo}`,
    '',
    '## Issue',
    task.problemStatement,
    '',
    '## Repository map (retrieved by the harness)',
    mapText,
    '',
    '## Source of the most relevant files',
    filesBlock,
    '',
    'Produce the unified diff now.',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 从模型回复中抽出 unified diff（剥离 markdown 围栏与前后闲散文本），并做排版规范化。
 * @param {string} text 模型回复。
 * @returns {string} 规范化后的纯 diff（可能为空串）。
 */
function extractDiff(text) {
  let s = text.trim();
  const fence = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(s);
  if (fence !== null) s = fence[1].trim();
  const start = s.search(/^diff --git /m);
  if (start > 0) s = s.slice(start);
  if (s.trim().length === 0) return '';
  return normalizePatch(s);
}

/**
 * 抽出每个目标文件的 hunk 起始行号（`@@ -N,...`）。修复轮据此精确开窗，而不是从头硬截。
 * @param {string} diff 补丁文本。
 * @returns {Map<string, number[]>} 文件 → 行号列表。
 */
function hunkLinesByFile(diff) {
  const out = new Map();
  let cur = null;
  for (const line of diff.split('\n')) {
    const f = /^\+\+\+ [ab]\/(.+?)(?:\t.*)?$/.exec(line);
    if (f !== null) {
      cur = f[1].trim();
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    const h = /^@@ -(?<old>\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h !== null && cur !== null && h.groups !== undefined) {
      out.get(cur).push(Number(h.groups.old));
    }
  }
  return out;
}

/**
 * 规范化 unified diff，修掉模型最常犯的两种**格式**缺陷（与语义无关，纯排版）：
 *   1. 上下文中的空行被写成真正的空字符串 —— unified diff 要求它是单个空格 `' '`；
 *   2. hunk 头 `@@ -a,b +c,d @@` 的行数统计与实际正文不符（含结尾缺换行导致末行丢失）。
 * 做法是**按正文重算 hunk 计数**，因此行数错、空行丢前缀、无前缀正文行三类问题一次收口。
 * 语义错误**不**在此修：上下文对不上时仍会失败，交由 `patch --fuzz` 或 pytest 判定。
 * @param {string} diff 原始补丁文本。
 * @returns {string} 规范化后的补丁（保证以换行结尾）。
 */
function normalizePatch(diff) {
  let src = diff.replace(/\r\n/g, '\n');
  if (src.endsWith('\n')) src = src.slice(0, -1); // 去掉结尾换行，避免被当成正文空行
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 具名捕获：早期用位置索引时，非捕获组 `(?:,\d+)?` 让 m[3]/m[4] 错位，拼出了
    // `@@ -192,5 + <标题>,8 @@undefined` 这种垃圾头（git 报 corrupt patch at line 4）。
    // 位置索引在正则改动时静默失效，故改用具名组；`--selftest` 有回归用例。
    const m =
      /^@@ -(?<old>\d+)(?:,(?<oldN>\d+))? \+(?<neu>\d+)(?:,(?<newN>\d+))? @@(?<tail>.*)$/.exec(
        line,
      );
    if (m === null) {
      out.push(line);
      i += 1;
      continue;
    }
    const g = m.groups;
    i += 1;
    // 收集本 hunk 正文，直到下一个 hunk 头 / 下一个文件头 / 文件结束。
    const body = [];
    while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
      body.push(lines[i]);
      i += 1;
    }
    let oldN = 0;
    let newN = 0;
    const fixed = body.map((l) => {
      if (l.startsWith('\\')) return l; // "\ No newline at end of file" 不计入行数
      if (l.startsWith('+')) {
        newN += 1;
        return l;
      }
      if (l.startsWith('-')) {
        oldN += 1;
        return l;
      }
      oldN += 1;
      newN += 1;
      if (l.startsWith(' ')) return l;
      return l.trim() === '' ? ' ' : ` ${l}`; // 空行补空格；漏前缀行补上下文前缀
    });
    out.push(`@@ -${g.old},${oldN} +${g.neu},${newN} @@${g.tail}`);
    out.push(...fixed);
  }
  return `${out.join('\n')}\n`;
}

/**
 * 规范化器的内置自检（`--selftest`）：用三个已知畸形输入验证输出，防止正则/索引回归。
 * @returns {number} 失败用例数（0 = 全通过）。
 */
function selftestNormalize() {
  const cases = [
    {
      name: '空上下文行缺前导空格',
      input: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n',
      want: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n',
    },
    {
      name: 'hunk 计数与实际不符（重算）',
      input: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,99 +1,99 @@\n a\n-b\n+c\n',
      want: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n',
    },
    {
      name: '少行号逗号形式 + 漏前缀正文行',
      input: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -7 +7 @@\n a\n b\n-c\n+d\n',
      want: 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -7,3 +7,3 @@\n a\n b\n-c\n+d\n',
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = normalizePatch(c.input);
    if (got !== c.want) {
      bad += 1;
      console.error(`❌ selftest 失败: ${c.name}`);
      console.error(`   期望 ${JSON.stringify(c.want)}`);
      console.error(`   实得 ${JSON.stringify(got)}`);
    }
  }
  console.log(
    bad === 0
      ? `✅ normalizePatch 自检 ${cases.length}/${cases.length} 通过`
      : `❌ ${bad} 个用例失败`,
  );
  return bad;
}

/**
 * 窗口读取自检：验证「关注行窗口在大文件里不会被静默丢弃」。
 *
 * 这是真实踩过的坑（flask 三轮改不对的根因）：旧实现窗口超预算时直接 `continue` 丢掉，
 * 只剩文件头 ⇒ 模型看不到目标区 ⇒ 凭记忆编造上下文。此用例把该行为钉死。
 * @returns {number} 失败数。
 */
function selftestWindow() {
  let bad = 0;
  const dir = mkdtempSync(join(tmpdir(), 'omni-win-'));
  try {
    const rel = 'big.py';
    const linesOut = [];
    for (let i = 1; i <= 800; i += 1) {
      linesOut.push(i === 400 ? 'TARGET_MARKER_LINE = 1' : `x${i} = "${'p'.repeat(80)}"`);
    }
    writeFileSync(join(dir, rel), linesOut.join('\n'), 'utf8');
    const got = readWindowBlock(dir, rel, [400], 20, 5000);
    if (got === null) {
      console.error('❌ selftest 窗口：返回 null');
      bad += 1;
    } else if (!got.includes('TARGET_MARKER_LINE')) {
      console.error('❌ selftest 窗口：目标行被静默丢弃（正是要防的回归）');
      bad += 1;
    } else if (got.length > 5000 + 200) {
      console.error(`❌ selftest 窗口：超出预算 ${got.length} > 5000`);
      bad += 1;
    }
    // 无关注行时退化为「只给文件头」，且不得抛错。
    const head = readWindowBlock(dir, rel, [], 20, 2000);
    if (head === null || head.length === 0) {
      console.error('❌ selftest 窗口：无关注行时应退化为文件头');
      bad += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? '✅ readWindowBlock 自检通过' : `❌ readWindowBlock ${bad} 项失败`);
  return bad;
}

if (process.argv.includes('--selftest')) {
  const bad = selftestNormalize() + selftestWindow();
  process.exit(bad === 0 ? 0 : 1);
}

/** 用 `git apply --check` 预检补丁能否应用（不改动工作区）。
 * @param {string} wt 工作区根。
 * @param {string} diff 补丁文本。
 * @returns {{ok: boolean, reason?: string}} 预检结果；ok=false 时 reason 为 git 的报错摘要。
 */
function checkPatch(wt, diff) {
  if (diff.trim().length === 0) return { ok: false, reason: '补丁为空' };
  // 补丁经 stdin 喂给 `git apply --check -`：不落临时文件 ⇒ 批量跑分不会累积删除操作，
  // 避免撞上宿主「批量删除需确认」栅栏（曾致整批在 rmSync 处抛错，把能跑的实例误记为失败）。
  try {
    execFileSync('git', ['apply', '--check', '--whitespace=fix', '-'], {
      cwd: wt,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: diff,
    });
    return { ok: true };
  } catch (error) {
    const stderr =
      error !== null && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr ?? '')
        : '';
    const msg = stderr.trim() !== '' ? stderr.trim() : String(error.message ?? error);
    return { ok: false, reason: msg.slice(0, 1500) };
  }
}

// ---------- 选实例 ----------
const tasks = SwebenchVerified.loadVerified(opts.verified);
/** 显式实例清单（文件形式，便于复现同一批）。
 * @returns {string[] | undefined} id 列表。 */
function loadInstanceList() {
  if (opts.instanceList === undefined) return undefined;
  return readFileSync(opts.instanceList, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}
const explicit = opts.instances ?? loadInstanceList();
let selected = tasks;
if (explicit !== undefined) {
  const want = new Set(explicit);
  selected = tasks.filter((t) => want.has(t.id));
} else if (opts.repo !== undefined) {
  selected = tasks.filter((t) => t.repo === opts.repo);
}
if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);

if (selected.length === 0) {
  console.error('❌ 没有选到任何实例');
  process.exit(1);
}

console.log(
  `[predict] 形态=${opts.payloadShape} fileK=${FILE_K} 内容文件=${opts.contentFiles} ` +
    `温度=${opts.temperature} 实例=${selected.length} 输出=${opts.out}`,
);

// ---------- 模型 ----------
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!opts.dryRun && apiKey === undefined) {
  console.error('❌ 缺 DEEPSEEK_API_KEY（.env 或环境变量）');
  process.exit(1);
}
const modelName = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const model = opts.dryRun
  ? null
  : new OpenAiCompatibleModel({
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey,
      model: modelName,
    });

// ---------- 主循环 ----------
const cache = new CorpusIndexCache({ maxEntries: 4 });
const engine = new RepoMapContextEngine();
const records = [];
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalMapChars = 0;

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, '', 'utf8');

for (const task of selected) {
  const t0 = Date.now();
  console.log(`\n=== ${task.id} (${task.repo} @ ${task.baseCommit.slice(0, 10)}) ===`);
  try {
    const wt = ensureCheckout(task.repo, task.baseCommit, task.id);
    const { text: mapText, files, symbols } = retrieve(cache, wt, task.problemStatement);

    // 零漂移自证：生产入口在同一 root/query/形态下必须逐字节等于本脚本的复刻产出。
    const prodText = engine.getRepoMapContext(wt, task.problemStatement, {
      payloadShape: opts.payloadShape,
      fileK: FILE_K,
    });
    if (prodText !== mapText) {
      console.error('❌ 检索复刻与生产入口不一致 —— 拒绝继续（防 A/B 分叉）');
      console.error(
        `  复刻长度=${mapText.length} 生产长度=${prodText === null ? 'null' : prodText.length}`,
      );
      process.exit(1);
    }

    const contents = buildContentBlocks(wt, files, symbols, opts);

    const messages = buildMessages(task, mapText, contents);
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    totalMapChars += mapText.length;
    console.log(
      `  检索命中 ${files.length} 文件，取正文 ${contents.length} 个；map=${mapText.length} 字符，prompt=${promptChars} 字符`,
    );

    if (opts.dryRun) {
      records.push({
        id: task.id,
        repo: task.repo,
        payloadShape: opts.payloadShape,
        filesHit: files.length,
        mapChars: mapText.length,
        promptChars,
        diffChars: 0,
        durationMs: Date.now() - t0,
        dryRun: true,
      });
      writeFileSync(opts.out, `${JSON.stringify({ instance_id: task.id, model_patch: '' })}\n`, {
        flag: 'a',
      });
      continue;
    }

    // ---- 生成 + 自修复循环 ----
    // 单轮生成对「hunk 上下文与真实源码不符」零容忍（首跑实测：模型凭空补了一层
    // `if name is not None:` 包装，git apply 立即失败）。真实 agent 都会读文件后重试，
    // 故此处给等量的修复机会：把 git apply 的报错 + **目标文件真实正文**回喂，要求改正。
    // 修复轮对两档形态**完全等价**，不引入形态间的额外优势。
    let diff = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let rounds = 0;
    let convo = messages;
    let lastReason = '';
    for (let attempt = 0; attempt <= opts.repairRounds; attempt += 1) {
      // 审计留痕：把每一轮真实送出的消息落盘（排查「模型为何看不到目标区」时唯一可信证据）。
      if (opts.dumpDir !== undefined) {
        mkdirSync(opts.dumpDir, { recursive: true });
        writeFileSync(
          join(opts.dumpDir, `${task.id}.round${attempt + 1}.txt`),
          convo
            .map((m) => `===== ${m.role} (${m.content.length} chars) =====\n${m.content}`)
            .join('\n\n'),
          'utf8',
        );
      }
      const out = await model.generate({
        messages: convo,
        tools: [],
        temperature: opts.temperature,
      });
      const raw = out.text ?? '';
      const usage = out.usage;
      if (usage !== undefined) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        totalPromptTokens += usage.promptTokens;
        totalCompletionTokens += usage.completionTokens;
      }
      const candidate = extractDiff(raw);
      rounds = attempt + 1;
      console.log(
        `  轮 ${rounds}：回复 ${raw.length} 字符 → diff ${candidate.length} 字符；` +
          `tokens in/out=${usage?.promptTokens ?? '?'}/${usage?.completionTokens ?? '?'}`,
      );
      diff = candidate;
      const check = checkPatch(wt, diff);
      if (check.ok) {
        console.log('  ✅ 补丁可应用');
        break;
      }
      lastReason = check.reason ?? '未知原因';
      console.log(`  ⚠️ 补丁不可应用：${lastReason.split('\n')[0]}`);
      if (attempt === opts.repairRounds) break;
      // 组装修复上下文：报错原文 + 补丁目标文件的**真实正文窗口**（按 hunk 行号精确开窗）。
      const hunkMap = hunkLinesByFile(diff);
      const realFiles = [...hunkMap.keys()]
        .map((rel) => {
          const body = readWindowBlock(
            wt,
            rel,
            hunkMap.get(rel) ?? [],
            Math.max(opts.windowRadius, 100),
            opts.contentChars,
          );
          return body === null
            ? `### ${rel}\n(该路径在仓库中不存在或不可读 —— 请先确认路径是否正确)`
            : `### ${rel} (REAL current content)\n\`\`\`python\n${body}\n\`\`\``;
        })
        .join('\n\n');
      convo = [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: [
            'Your patch does NOT apply cleanly. `git apply` reported:',
            '```',
            lastReason,
            '```',
            '',
            'Below is the REAL current content of the file(s) your patch targets. Align your hunks',
            '(line numbers AND context lines) exactly with this content, then output a corrected diff.',
            realFiles,
            '',
            'Output ONLY the corrected unified diff.',
          ].join('\n'),
        },
      ];
    }
    if (diff.length === 0) {
      console.log('  ⚠️ 未抽出 diff（空补丁 ⇒ 该题按未修复计）');
    }
    const applied = checkPatch(wt, diff).ok;

    appendFileSync(
      opts.out,
      `${JSON.stringify({ instance_id: task.id, model_patch: diff })}\n`,
      'utf8',
    );
    records.push({
      id: task.id,
      repo: task.repo,
      payloadShape: opts.payloadShape,
      filesHit: files.length,
      mapChars: mapText.length,
      promptChars,
      diffChars: diff.length,
      promptTokens,
      completionTokens,
      rounds,
      applyCheck: applied,
      applyError: applied ? undefined : lastReason.slice(0, 300),
      durationMs: Date.now() - t0,
    });
    // 顺手打印 diff 的头几行，便于人工抽查补丁形状是否合法（不是打日志噪声）。
    if (diff.length > 0) {
      console.log(`  diff 首行: ${diff.split('\n').slice(0, 3).join(' | ')}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ ${task.id} 失败: ${msg}`);
    appendFileSync(
      opts.out,
      `${JSON.stringify({ instance_id: task.id, model_patch: '' })}\n`,
      'utf8',
    );
    records.push({ id: task.id, repo: task.repo, payloadShape: opts.payloadShape, error: msg });
  }
}

// ---------- 元数据报告（与 predictions 分开，便于回看 A/B 的 token 账） ----------
const report = {
  generatedAt: new Date().toISOString(),
  payloadShape: opts.payloadShape,
  fileK: FILE_K,
  contentFiles: opts.contentFiles,
  contentChars: opts.contentChars,
  temperature: opts.temperature,
  model: modelName,
  instances: selected.length,
  totalPromptTokens,
  totalCompletionTokens,
  avgMapChars: records.length > 0 ? Math.round(totalMapChars / records.length) : 0,
  records,
};
const reportPath = `${opts.out}.report.json`;
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
const avgTok =
  records.filter((r) => r.promptTokens !== undefined).length > 0
    ? Math.round(totalPromptTokens / records.filter((r) => r.promptTokens !== undefined).length)
    : 0;
console.log(
  `\n[predict] 完成 ${records.length} 实例；平均 map=${report.avgMapChars} 字符；` +
    `平均 prompt token=${avgTok}；总 token in/out=${totalPromptTokens}/${totalCompletionTokens}`,
);
console.log(`[predict] predictions: ${opts.out}`);
console.log(`[predict] 元数据报告: ${reportPath}`);
