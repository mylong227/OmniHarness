#!/usr/bin/env node
/**
 * 技能包签名工具（`npm run skill:sign -- --input skills.json --key private.pem --out signed.json`）。
 * 输入数组或 `{skills:[...]}`；输出 `{version:1,skills,publicKey,signature}`。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'dist', 'src', 'skill', 'skillManifestSigner.js');

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`参数错误: ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  if (!out.input || !out.key || !out.out) {
    throw new Error('用法: skill:sign --input skills.json --key private.pem --out signed.json');
  }
  return out;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const parsed = JSON.parse(readFileSync(args.input, 'utf8').replace(/^\uFEFF/u, ''));
  const skills = Array.isArray(parsed) ? parsed : parsed.skills;
  if (!Array.isArray(skills)) throw new Error('输入必须含 skills 数组');
  const { SkillManifestSigner } = await import(pathToFileURL(MODULE).href);
  const manifest = SkillManifestSigner.sign(skills, readFileSync(args.key, 'utf8'));
  writeFileSync(args.out, JSON.stringify(manifest, null, 2));
  console.log(`✓ 已签名 ${String(skills.length)} 条技能 → ${args.out}`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
