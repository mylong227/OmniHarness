import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../../src/plugin/registry.js';

/** 在临时目录建一个 plugins 子目录，返回可传入 PluginRegistry 的配置。 */
function makeOptions(
  overrides: Record<string, unknown> = {},
): { pluginsDir: string } & Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'omni-reg-'));
  const pluginsDir = join(root, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  return { pluginsDir, ...overrides } as { pluginsDir: string } & Record<string, unknown>;
}

/** 设置 env 并在 finally 还原。 */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

test('OMNI_REGISTRY_URL 能覆盖默认 registry URL', () => {
  const envUrl = 'https://enterprise.registry.internal/index.json';
  withEnv('OMNI_REGISTRY_URL', envUrl, () => {
    const registry = new PluginRegistry(makeOptions());
    assert.strictEqual(registry.options.registryUrl, envUrl);
  });
});

test('缺省 registryUrl 落回内置默认 URL', () => {
  withEnv('OMNI_REGISTRY_URL', undefined, () => {
    const registry = new PluginRegistry(makeOptions());
    assert.strictEqual(registry.options.registryUrl, 'https://registry.omniharness.dev/index.json');
  });
});

test('显式 registryUrl 优先于 env 覆盖', () => {
  withEnv('OMNI_REGISTRY_URL', 'https://env.example/index.json', () => {
    const registry = new PluginRegistry(
      makeOptions({ registryUrl: 'https://explicit.example/index.json' }),
    );
    assert.strictEqual(registry.options.registryUrl, 'https://explicit.example/index.json');
  });
});

test('PluginRegistry 构造不抛（构造后即可被 GC）', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-reg-clean-'));
  try {
    const pluginsDir = join(root, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    assert.doesNotThrow(() => new PluginRegistry({ pluginsDir }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
