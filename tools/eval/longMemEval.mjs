#!/usr/bin/env node
/**
 * LongMemEval-S 离线代理评测（`npm run eval:longmem -- --dataset cases.json`）。
 *
 * 输入：`{cases:[{id,question,answer,facts:[{text,trust?}]}]}` 或数组。
 * 用真实 `FileLongTermMemory` 召回 top-k，按答案文本命中算 recall@k / MRR。
 * 这是本地检索代理，不是官方 LongMemEval-S 的模型判分复刻。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'dist', 'src', 'eval', 'longMemEval.js');
const MEMORY = join(ROOT, 'dist', 'src', 'adapters', 'memory', 'fileLongTermMemory.js');

function parseArgs(argv) {
  const out = { dataset: undefined, k: 5, trustedOnly: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} 需要取值`);
      i += 1;
      return next;
    };
    if (arg === '--dataset') out.dataset = value();
    else if (arg === '--k') out.k = Number(value());
    else if (arg === '--trusted-only') out.trustedOnly = true;
    else if (arg === '--json') out.json = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (out.dataset === undefined) throw new Error('缺少 --dataset <cases.json>');
  if (!Number.isInteger(out.k) || out.k < 1) throw new Error('--k 必须是正整数');
  return out;
}

function loadCases(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases)) throw new Error('dataset 必须含 cases 数组');
  return cases;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadCases(args.dataset);
  const { LongMemEval } = await import(pathToFileURL(MODULE).href);
  const { FileLongTermMemory } = await import(pathToFileURL(MEMORY).href);
  const dir = mkdtempSync(join(tmpdir(), 'omni-longmem-'));
  const memories = new Map();
  try {
    for (const [index, testCase] of cases.entries()) {
      const memory = new FileLongTermMemory(join(dir, `${String(index)}.jsonl`));
      for (const [factIndex, fact] of (testCase.facts ?? []).entries()) {
        memory.remember({
          id: `${String(index)}-${String(factIndex)}`,
          text: String(fact.text ?? ''),
          importance: 4,
          createdAt: new Date().toISOString(),
          sessionId: 'eval',
          source: 'tool',
          ...(fact.trust !== undefined ? { trust: fact.trust } : {}),
        });
      }
      memories.set(testCase.question, memory);
    }
    const report = await LongMemEval.score(
      cases,
      async (query, k) => memories.get(query)?.recall(query, k) ?? [],
      args.k,
      args.trustedOnly,
    );
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `LongMemEval-S 代理: cases=${String(report.cases)} hits=${String(report.hits)} recall@${String(args.k)}=${report.recallAtK.toFixed(3)} MRR=${report.mrr.toFixed(3)}`,
      );
      for (const result of report.results) {
        console.log(`  ${result.hit ? '✓' : '✗'} ${result.id} rank=${String(result.rank ?? '-')}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
