#!/usr/bin/env node
/**
 * trace → patch 计划器（`npm run trace:patch -- --input signals.json`）。
 *
 * 输入是**失败信号数组**（JSON）或 JSONL（每行一个 `{tool,ok,output,path,command}`）。
 * 输出是可复核的补丁计划；**不改文件、不自动合并**——补丁必须经测试验证后才能落盘。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'dist', 'src', 'eval', 'tracePatchPlanner.js');

/** 解析 `--input` / `--json`。 */
function parseArgs(argv) {
  const out = { input: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--input') {
      out.input = argv[i + 1];
      if (out.input === undefined) throw new Error('--input 需要文件路径');
      i += 1;
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (out.input === undefined) throw new Error('缺少 --input <signals.json>');
  return out;
}

/** 读 JSON 数组或 JSONL。 */
function readSignals(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('输入 JSON 必须是数组');
    return parsed;
  }
  const lines = text.split(/\r?\n/u);
  const signals = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      signals.push(JSON.parse(line));
    } catch {
      throw new Error(`第 ${String(index + 1)} 行不是合法 JSON`);
    }
  }
  return signals;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { TracePatchPlanner } = await import(pathToFileURL(MODULE).href);
  const plan = TracePatchPlanner.plan(readSignals(args.input));
  console.log(args.json ? JSON.stringify(plan, null, 2) : TracePatchPlanner.toMarkdown(plan));
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
