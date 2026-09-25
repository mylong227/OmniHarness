// 模型接入页（#providerKeys/model.probe）服务端单元测试：
// Key 打码、providerKeys 配置校验、未配 Key 探测的 fail-closed 路径（零网络依赖）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderPresets } from '../../src/server/services/providerPresets.js';
import { ProviderProbe } from '../../src/server/services/providerProbe.js';
import { ConfigError } from '../../src/config/configError.js';
import { SsrfPolicy } from '../../src/security/ssrfPolicy.js';
import { SsrfGuard } from '../../src/security/ssrfGuard.js';

test('maskKey：保留前 3 后 4，短 Key 全打码', () => {
  assert.strictEqual(ProviderPresets.maskKey('sk-1234567890abcdef'), 'sk-****cdef'); // omniharness:fake-secret（测试夹具假密钥）
  assert.strictEqual(ProviderPresets.maskKey('short'), '****');
  assert.strictEqual(ProviderPresets.maskKey('12345678'), '****');
});

test('providerPresetOf：按厂商标识查预设', () => {
  const deepseek = ProviderPresets.providerPresetOf('deepseek');
  assert.strictEqual(deepseek?.adapter, 'openai');
  assert.strictEqual(deepseek?.baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(ProviderPresets.providerPresetOf('no-such-vendor'), undefined);
});

test('normalizeConfig：providerKeys 合法对象通过，非法形状 fail-closed', () => {
  const ok = ConfigError.normalizeConfig({ providerKeys: { deepseek: 'sk-1', ollama: 'x' } });
  assert.deepStrictEqual(ok.providerKeys, { deepseek: 'sk-1', ollama: 'x' });
  assert.throws(() => ConfigError.normalizeConfig({ providerKeys: 'not-an-object' }), ConfigError);
  assert.throws(() => ConfigError.normalizeConfig({ providerKeys: { deepseek: 42 } }), ConfigError);
  assert.throws(() => ConfigError.normalizeConfig({ providerKeys: { deepseek: '' } }), ConfigError);
});

test('probeProvider：未配 Key 的必需厂商不发起网络请求，直接返回未配置', async () => {
  const preset = ProviderPresets.providerPresetOf('deepseek');
  assert.ok(preset !== undefined);
  const result = await ProviderProbe.probeProvider(preset, undefined);
  assert.strictEqual(result.configured, false);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, '未配置 API Key');
  assert.strictEqual(result.source, 'none');
});

test('probeProvider：免 Key 厂商标记为已配置', async () => {
  const ollama = ProviderPresets.providerPresetOf('ollama');
  assert.ok(ollama !== undefined);
  const result = await ProviderProbe.probeProvider(ollama, undefined);
  assert.strictEqual(result.configured, true);
  // ok 与否取决于本地 11434 是否在线（环境相关），不在此断言网络结果。
});

test('probeProvider：注入的 ssrfPolicy 生效（配置化前写死默认档 ⇒ 配了不生效）', async () => {
  const preset = ProviderPresets.providerPresetOf('deepseek');
  assert.ok(preset !== undefined);
  // 只换主机名：默认档不含 `.provider-probe.invalid` ⇒ 不注入策略时会真的去发请求（拿到「网络不可达」），
  // 注入后必须在**发请求之前**被 SSRF 拦下 ⇒ 断言错误前缀即可区分两条路径（且无需网络）。
  const target = { ...preset, baseUrl: 'https://gw.provider-probe.invalid/v1' };
  const policy = SsrfPolicy.resolveSsrfPolicy({ internalSuffixes: ['.provider-probe.invalid'] });
  const blocked = await ProviderProbe.probeProvider(target, 'sk-test', policy);
  assert.strictEqual(blocked.ok, false);
  assert.match(String(blocked.error), /^SSRF 拦截/, `应被 SSRF 拦下，实际：${blocked.error}`);
  // 反向：默认档不含该后缀 ⇒ 同一主机在默认策略下不被 SSRF 拦（证明「拦」来自注入的策略本身）
  assert.strictEqual(
    SsrfGuard.inspectHost('gw.provider-probe.invalid', SsrfGuard.ssrfOptionsFor()).blocked,
    false,
  );
});
