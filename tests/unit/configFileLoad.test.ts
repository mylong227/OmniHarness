// 配置文件 load（审计 §30 Gap ⑥）单元测试。
// 区分两种情形（fail-closed）：
//  - 文件不存在 → 返回空配置 {}（合法空配置，cliSystem.test 依赖此语义）；
//  - 文件存在但非法 JSON → 抛 ConfigError 暴露，不再静默回退 {} 掩盖错误。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFile } from '../../src/config/configFile.js';
import { ConfigError } from '../../src/config/configError.js';

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-cfgload-'));
  return join(dir, name);
}

test('load：文件不存在返回空配置 {}（不抛错）', () => {
  const cfg = configFile.load(join(tmpdir(), `oh-nonexistent-${process.pid}.json`));
  assert.deepStrictEqual(cfg, {});
});

test('load：合法 JSON 原样返回', () => {
  const path = tmpFile('ok.json');
  writeFileSync(path, JSON.stringify({ model: 'gpt-4o', approval: 'auto' }), 'utf8');
  const cfg = configFile.load(path);
  assert.strictEqual(cfg.model, 'gpt-4o');
  assert.strictEqual(cfg.approval, 'auto');
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('load：非法 JSON 抛 ConfigError（不再静默回退 {} 掩盖错误）', () => {
  const path = tmpFile('bad.json');
  writeFileSync(path, '{ "model": "gpt-4o", ', 'utf8'); // 截断的非法 JSON
  assert.throws(
    () => configFile.load(path),
    (err: unknown) => {
      return err instanceof ConfigError && /配置文件解析失败/.test(err.message);
    },
  );
  rmSync(join(path, '..'), { recursive: true, force: true });
});
