#!/usr/bin/env node
/**
 * 首次运行配置脚手架（零依赖，ESM）。
 *
 * 用法：
 *   node scripts/init-config.mjs            # 在 cwd 生成 omniharness.json（已存在则跳过）
 *   node scripts/init-config.mjs --force    # 覆盖已有配置
 *
 * 生成的字段全部落在 `configLayer.ts` 的 KNOWN_KEYS 白名单内，可被严格校验通过。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), 'omniharness.json');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.error('[init-config] omniharness.json 已存在，跳过（用 --force 覆盖）');
  process.exit(0);
}

const config = {
  modelAdapter: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  storageAdapter: 'jsonl',
  storageDir: '.omniharness/sessions',
  approval: 'rules',
  sandbox: 'policy',
  escalation: 'ask',
  elevatedSandbox: 'policy',
  maxSteps: 32,
  longTermMemoryEncryption: false,
  longTermMemoryKeyFile: '.omniharness/memory.key',
  mcpServers: {},
};

writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`[init-config] 已生成 ${target}`);
console.log('[init-config] 请编辑 apiKey / baseUrl / model 后运行：');
console.log('               node dist/src/cli/exec.js serve --port 8787');
