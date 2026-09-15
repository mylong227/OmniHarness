#!/usr/bin/env node
// 真实语义召回对比（U3 真实落地）：用真实 @huggingface/transformers 本地模型
// （Xenova/all-MiniLM-L6-v2，首次需联网下载 ~23MB ONNX 权重）端到端跑 BM25 vs 混合检索，
// 验证「共振语义层」对词法鸿沟查询的召回提升。复用与合成评测完全相同的
// repoMapContext / getHybridRepoMapContext 代码路径，仅把嵌入换成真实模型。
//
// 用法：
//   node evals/recall-compare-real.mjs
//   OMNI_EMBEDDING_CACHE_DIR=/path node evals/recall-compare-real.mjs   # 指定权重缓存目录
//
// 首次运行需联网下载权重；离线环境请先预置权重到缓存目录并设置 OMNI_EMBEDDING_OFFLINE=1。

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');

function importDist(...segments) {
  return import(pathToFileURL(join(DIST, ...segments)).href);
}

const { RepoMapContextEngine } = await importDist('context', 'repoMapContextEngine.js');
const { TransformersEmbeddingAdapter } = await importDist(
  'adapters',
  'embedding',
  'transformersEmbeddingAdapter.js',
);

/** repo-map 生产接入器实例（原模块级包装函数已随重命名移除）。 */
const repoMap = new RepoMapContextEngine();

// 概念簇语料（每个簇多个文件；查询使用「零词面重叠」的语义表述，制造词法鸿沟）。
const CORPUS = {
  auth: [
    [
      'auth_login.ts',
      'export function login(user: string, pass: string) { /* 校验用户凭证与会话 */ return issueToken(user); }\n',
    ],
    [
      'auth_token.ts',
      'export function issueToken(subject: string) { /* 签发凭据、刷新会话授权 */ return sign(subject); }\n',
    ],
  ],
  math: [
    [
      'math_calc.ts',
      'export function derivative(f: (x:number)=>number) { /* 求导 */ return finiteDiff(f); }\n',
    ],
    [
      'math_series.ts',
      'export function summation(n: number) { /* 级数求和 / 积分近似 */ let s=0; for (let i=1;i<=n;i++) s+=i; return s; }\n',
    ],
  ],
  io: [
    [
      'io_file.ts',
      'export function readFile(path: string) { /* 文件读取流 */ return openStream(path); }\n',
    ],
    [
      'io_stream.ts',
      'export function openStream(p: string) { /* 缓冲流读写 */ return buffer(p); }\n',
    ],
  ],
  str: [
    [
      'str_util.ts',
      'export function reverse(s: string) { /* 字符串反转 */ return s.split("").reverse().join(""); }\n',
    ],
    [
      'str_format.ts',
      'export function upper(s: string) { /* 子串大写化 */ return s.toUpperCase(); }\n',
    ],
  ],
};

// 词法鸿沟查询：查询词与目标文件几乎无字面交集。
const QUERIES = [
  { q: 'authenticate user credentials and issue a session', target: 'auth' },
  { q: 'compute derivative and integral summation', target: 'math' },
  { q: 'read and write a file stream with buffering', target: 'io' },
  { q: 'reverse a substring and uppercase it', target: 'str' },
];

function buildWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'omni-semreal-'));
  for (const [cluster, files] of Object.entries(CORPUS)) {
    const dir = join(root, cluster);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of files) writeFileSync(join(dir, name), content);
  }
  return root;
}

function surfacedFiles(context) {
  const files = new Set();
  for (const line of context.split('\n')) {
    const m = line.match(/📄\s+(.+)/);
    if (m) files.add(m[1].trim());
  }
  return files;
}

// 支持镜像端点：无直连 huggingface 的网络下，用 HF_ENDPOINT 指向镜像（如 https://hf-mirror.com），
// 用 HF_WASM_PATH 覆盖 onnxruntime wasm 二进制路径。仅影响本评测脚本的模型拉取，不动生产适配器。
async function applyMirrorEnv() {
  const ep = process.env.HF_ENDPOINT;
  const wasm = process.env.HF_WASM_PATH;
  if (!ep && !wasm) return;
  const { env } = await import('@huggingface/transformers');
  if (ep) env.remoteHost = ep.endsWith('/') ? ep : ep + '/';
  if (wasm) env.backends.onnx.wasm.wasmPaths = wasm;
}

async function main() {
  await applyMirrorEnv();
  const root = buildWorkspace();
  let embedding;
  try {
    embedding = new TransformersEmbeddingAdapter({
      cacheDir: process.env.OMNI_EMBEDDING_CACHE_DIR,
      localFilesOnly: process.env.OMNI_EMBEDDING_OFFLINE === '1',
    });
    // 触发模型加载（首次联网下载）。
    await embedding.embed(['warmup']);
    console.log('✅ 真实嵌入模型已加载');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ 真实嵌入模型加载失败（U3 真实落地需联网下载权重一次）：\n  ${msg}\n`);
    console.error('离线环境请先预置权重到缓存目录并设置 OMNI_EMBEDDING_OFFLINE=1。');
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }

  const rows = [];
  let bm25Hit = 0;
  let hybHit = 0;
  for (const { q, target } of QUERIES) {
    const targetFiles = new Set(CORPUS[target].map(([name]) => `${target}/${name}`));
    const bm25Ctx = repoMap.getRepoMapContext(root, q) ?? '';
    const hybCtx = (await repoMap.getHybridRepoMapContext(root, q, embedding)) ?? '';
    const bm25Surf = surfacedFiles(bm25Ctx);
    const hybSurf = surfacedFiles(hybCtx);
    const bm25Recall = [...targetFiles].filter((f) => bm25Surf.has(f)).length / targetFiles.size;
    const hybRecall = [...targetFiles].filter((f) => hybSurf.has(f)).length / targetFiles.size;
    bm25Hit += bm25Recall;
    hybHit += hybRecall;
    rows.push({ q, target, bm25Recall, hybRecall });
  }
  rmSync(root, { recursive: true, force: true });

  console.log('\n=== U3 真实语义召回对比（真实 all-MiniLM-L6-v2）===');
  for (const r of rows) {
    console.log(
      `  ${r.target.padEnd(5)} BM25=${(r.bm25Recall * 100).toFixed(0)}%  Hybrid=${(r.hybRecall * 100).toFixed(0)}%   "${r.q}"`,
    );
  }
  const n = QUERIES.length;
  console.log(
    `\n平均召回: BM25=${((bm25Hit / n) * 100).toFixed(1)}%  Hybrid=${((hybHit / n) * 100).toFixed(1)}%  (+${(((hybHit - bm25Hit) / n) * 100).toFixed(1)}pp)`,
  );
}

main().catch((err) => {
  console.error('真实召回对比异常:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
