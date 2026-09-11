import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalogService } from '../../src/server/modelCatalogService.js';
import { PROVIDER_PRESETS } from '../../src/server/providerPresets.js';
import type { FileConfig } from '../../src/config/configFile.js';

/** 取一个需要 Key 的远程预设（用其 baseUrl 精确匹配 active 判定）。 */
const remotePreset = PROVIDER_PRESETS.find((p) => p.needsKey);

test('ModelCatalogService.catalog：无实测缓存时只回当前模型（不回退预设兜底）', () => {
  const svc = new ModelCatalogService({
    fileConfig: () => ({ modelAdapter: 'openai', model: 'gpt-4o' }),
    adapterOverride: () => undefined,
  });
  const out = svc.catalog() as { active: { models: string[]; model: string; defaultModel: string } };
  assert.deepEqual(out.active.models, ['gpt-4o']);
  assert.strictEqual(out.active.model, 'gpt-4o');
  assert.ok(out.active.defaultModel.length > 0);
});

test('ModelCatalogService.catalog：adapterOverride 优先于文件配置', () => {
  const svc = new ModelCatalogService({
    fileConfig: () => ({ modelAdapter: 'mock' }),
    adapterOverride: () => 'anthropic',
  });
  const out = svc.catalog() as { active?: { id: string } };
  const expected = PROVIDER_PRESETS.filter((p) => p.adapter === 'anthropic')[0];
  assert.strictEqual(out.active?.id, expected?.id);
});

test('ModelCatalogService.catalog：无匹配适配器时 active 为 undefined', () => {
  const svc = new ModelCatalogService({
    fileConfig: () => ({ modelAdapter: 'mock' }),
    adapterOverride: () => undefined,
  });
  const out = svc.catalog() as { providers: unknown[]; active?: unknown };
  assert.strictEqual(out.active, undefined);
  assert.strictEqual(out.providers.length, PROVIDER_PRESETS.length);
});

test('ModelCatalogService.probe：未配 Key 的厂商不经网络即回 configured=false', async () => {
  assert.ok(remotePreset !== undefined, '预设表应含需 Key 的远程厂商');
  const svc = new ModelCatalogService({
    fileConfig: () => ({ modelAdapter: remotePreset.adapter, baseUrl: remotePreset.baseUrl }),
    adapterOverride: () => undefined,
  });
  const out = (await svc.probe({ provider: remotePreset.id })) as {
    providers: { configured: boolean; ok: boolean; id: string }[];
  };
  assert.strictEqual(out.providers.length, 1);
  assert.strictEqual(out.providers[0]?.configured, false);
  assert.strictEqual(out.providers[0]?.ok, false);
  // 探测结果已进缓存：ok=false 时 catalog 不回带任何"真实模型"。
  const catalog = svc.catalog() as { active: { models: string[] } };
  assert.deepEqual(catalog.active.models, []);
});

test('ModelCatalogService.probe：未知厂商 id 返回空结果（无副作用）', async () => {
  const svc = new ModelCatalogService({
    fileConfig: () => ({}),
    adapterOverride: () => undefined,
  });
  const out = (await svc.probe({ provider: '__not-a-provider__' })) as { providers: unknown[] };
  assert.deepEqual(out.providers, []);
});

test('ModelCatalogService.resolveOverride：mock / llamacpp / 未知适配器一律 undefined', () => {
  const cases: (FileConfig | undefined)[] = [
    { modelAdapter: 'mock' },
    { modelAdapter: 'llamacpp' },
    { modelAdapter: 'responses' }, // 预设表无该适配器
    {},
  ];
  for (const file of cases) {
    const svc = new ModelCatalogService({
      fileConfig: () => file as FileConfig,
      adapterOverride: () => undefined,
    });
    assert.strictEqual(svc.resolveOverride(), undefined, JSON.stringify(file));
  }
});

test('ModelCatalogService.resolveOverride：显式凭据时构造出真实模型端口', () => {
  const preset = PROVIDER_PRESETS.find((p) => p.adapter === 'openai');
  assert.ok(preset !== undefined);
  const svc = new ModelCatalogService({
    fileConfig: () => ({ modelAdapter: 'openai', baseUrl: preset.baseUrl, apiKey: 'sk-test', model: 'm1' }),
    adapterOverride: () => undefined,
  });
  assert.ok(svc.resolveOverride() !== undefined, '有凭据的远程厂商应可构造模型端口');
});
