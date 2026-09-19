import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRebase } from '../../src/config/configRebase.js';
import type { ResolvedConfig } from '../../src/config/configFactory.js';

/** 造一份「字段齐全」的伪配置：声明式字段 + 三个工作区耦合端口。 */
const seed = (workspaceRoot: string): ResolvedConfig =>
  ({
    workspaceRoot,
    maxSteps: 7,
    fragments: ['行为准则 A', '行为准则 B'],
    selfVerify: { command: 'npm test', cooldownMs: 0 },
    lspServer: { serverCommand: 'typescript-language-server' },
    costBudgetUsd: 3,
    deferredTools: ['web_search'],
    tools: { placeholder: true },
    spill: { placeholder: true },
    longTermMemory: { placeholder: true },
  }) as unknown as ResolvedConfig;

test('ConfigRebase：切换工作区后声明式字段全部保留（fragments 不再被丢弃）', () => {
  const next = ConfigRebase.forWorkspace(seed('D:/old'), 'D:/new') as unknown as Record<
    string,
    unknown
  >;
  assert.strictEqual(next['workspaceRoot'], 'D:/new');
  assert.deepStrictEqual(next['fragments'], ['行为准则 A', '行为准则 B']);
  assert.strictEqual(next['maxSteps'], 7);
  assert.deepStrictEqual(next['selfVerify'], { command: 'npm test', cooldownMs: 0 });
  assert.deepStrictEqual(next['lspServer'], { serverCommand: 'typescript-language-server' });
  assert.strictEqual(next['costBudgetUsd'], 3);
  assert.deepStrictEqual(next['deferredTools'], ['web_search']);
});

test('ConfigRebase：三个工作区耦合端口被剔除，交装配层按新根重造', () => {
  const next = ConfigRebase.forWorkspace(seed('D:/old'), 'D:/new') as unknown as Record<
    string,
    unknown
  >;
  for (const key of ConfigRebase.WORKSPACE_COUPLED) {
    assert.strictEqual(key in next, false, `${key} 应被剔除`);
  }
  assert.deepStrictEqual([...ConfigRebase.WORKSPACE_COUPLED], ['tools', 'spill', 'longTermMemory']);
});

test('ConfigRebase：纯函数，不改动入参（避免污染调用方持有的旧配置）', () => {
  const original = seed('D:/old');
  ConfigRebase.forWorkspace(original, 'D:/new');
  assert.strictEqual(original.workspaceRoot, 'D:/old');
  assert.strictEqual((original as unknown as Record<string, unknown>)['tools'] !== undefined, true);
});
