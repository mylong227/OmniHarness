// 模型接入页（#providerKeys/model.probe）服务端单元测试：
// Key 打码、providerKeys 配置校验、未配 Key 探测的 fail-closed 路径（零网络依赖）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { maskKey, providerPresetOf } from '../../src/server/providerPresets.js';
import { probeProvider } from '../../src/server/providerProbe.js';
import { normalizeConfig, ConfigError } from '../../src/config/configError.js';

test('maskKey：保留前 3 后 4，短 Key 全打码', () => {
  assert.strictEqual(maskKey('sk-1234567890abcdef'), 'sk-****cdef');
  assert.strictEqual(maskKey('short'), '****');
  assert.strictEqual(maskKey('12345678'), '****');
});

test('providerPresetOf：按厂商标识查预设', () => {
  const deepseek = providerPresetOf('deepseek');
  assert.strictEqual(deepseek?.adapter, 'openai');
  assert.strictEqual(deepseek?.baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(providerPresetOf('no-such-vendor'), undefined);
});

test('normalizeConfig：providerKeys 合法对象通过，非法形状 fail-closed', () => {
  const ok = normalizeConfig({ providerKeys: { deepseek: 'sk-1', ollama: 'x' } });
  assert.deepStrictEqual(ok.providerKeys, { deepseek: 'sk-1', ollama: 'x' });
  assert.throws(() => normalizeConfig({ providerKeys: 'not-an-object' }), ConfigError);
  assert.throws(() => normalizeConfig({ providerKeys: { deepseek: 42 } }), ConfigError);
  assert.throws(() => normalizeConfig({ providerKeys: { deepseek: '' } }), ConfigError);
});

test('probeProvider：未配 Key 的必需厂商不发起网络请求，直接返回未配置', async () => {
  const preset = providerPresetOf('deepseek');
  assert.ok(preset !== undefined);
  const result = await probeProvider(preset, undefined);
  assert.strictEqual(result.configured, false);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, '未配置 API Key');
  assert.strictEqual(result.source, 'none');
});

test('probeProvider：免 Key 厂商标记为已配置', async () => {
  const ollama = providerPresetOf('ollama');
  assert.ok(ollama !== undefined);
  const result = await probeProvider(ollama, undefined);
  assert.strictEqual(result.configured, true);
  // ok 与否取决于本地 11434 是否在线（环境相关），不在此断言网络结果。
});
