#!/usr/bin/env node
/**
 * 技能包验签工具（`npm run skill:verify -- --input signed.json --trusted-key public.pem`）。
 */
import { readFileSync } from 'node:fs';
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
  if (!out.input || !out['trusted-key']) {
    throw new Error('用法: skill:verify --input signed.json --trusted-key public.pem');
  }
  return out;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const { SkillManifestSigner } = await import(pathToFileURL(MODULE).href);
  const manifest = JSON.parse(readFileSync(args.input, 'utf8').replace(/^\uFEFF/u, ''));
  if (!SkillManifestSigner.isSigned(manifest)) throw new Error('不是签名技能包');
  const ok = SkillManifestSigner.verify(manifest, readFileSync(args['trusted-key'], 'utf8'));
  if (!ok) throw new Error('签名无效或与可信公钥不匹配');
  console.log(`✓ 验签通过：${String(manifest.skills.length)} 条技能`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
