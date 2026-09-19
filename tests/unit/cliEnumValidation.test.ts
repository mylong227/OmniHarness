import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/argParser.js';
import { SandboxManager } from '../../src/adapters/sandbox/sandboxManager.js';
import type { SandboxProfile } from '../../src/adapters/sandbox/sandboxManager.js';

/** 临时工作区（避免测试依赖真实 cwd）。 */
function testRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omni-enum-'));
}

test('非法 --sandbox 抛错而非静默回落 passthrough（fail-open 回归）', () => {
  // 拼错一个字母：修复前会经 `as` 强转穿过类型系统，
  // 再由 SandboxManager.build() 回落 PassthroughSandbox = 全放行。
  assert.throws(
    () => parseArgs(['--prompt', 'hi', '--sandbox', 'landock']),
    /非法参数值: --sandbox = landock/,
    '拼错的沙箱 profile 必须报错，绝不能静默变成全放行',
  );
});

test('非法 --elevated-sandbox 抛错（提权复核同样不容 fail-open）', () => {
  // 'restricted' 已是合法提权后端（见 ELEVATED_SANDBOXES），此处用真不在枚举内的值验 fail-closed。
  assert.throws(
    () => parseArgs(['--prompt', 'hi', '--elevated-sandbox', 'passthru']),
    /非法参数值: --elevated-sandbox = passthru/,
  );
});

test('其余安全/行为枚举参数全部严格校验', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['--approval', 'rulez'],
    ['--approval-ask', 'maybe'],
    ['--escalation', 'auto!'],
    ['--model-adapter', 'gpt'],
    ['--storage-adapter', 'mysql'],
    ['--spill-adapter', 'disk'],
    ['--events', 'verbose'],
  ];
  for (const [flag, value] of cases) {
    assert.throws(
      () => parseArgs(['--prompt', 'hi', flag, value]),
      new RegExp(`非法参数值: ${flag.replace('-', '\\-')} = ${value}`),
      `${flag} 应拒绝非法值 ${value}`,
    );
  }
});

test('错误提示列出可选值（可自愈，不留用户在黑暗里）', () => {
  try {
    parseArgs(['--prompt', 'hi', '--sandbox', 'nope']);
    assert.fail('应抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(
      message,
      /可选: passthrough \| policy \| restricted \| landlock \| seatbelt \| bwrap \| unshare/,
    );
  }
});

test('合法枚举值全部正常解析（无过度收紧）', () => {
  const sandboxProfiles = [
    'passthrough',
    'policy',
    'restricted',
    'landlock',
    'seatbelt',
    'bwrap',
    'unshare',
  ] as const;
  for (const profile of sandboxProfiles) {
    const args = parseArgs(['--prompt', 'hi', '--sandbox', profile]);
    assert.strictEqual(args?.sandbox, profile, `${profile} 应可正常解析`);
  }
  const mixed = parseArgs([
    '--prompt',
    'hi',
    '--approval',
    'guardian',
    '--approval-ask',
    'deny',
    '--escalation',
    'ask',
    '--elevated-sandbox',
    'policy',
    '--model-adapter',
    'llamacpp',
    '--storage-adapter',
    'sqlite',
    '--spill-adapter',
    'memory',
    '--events',
    'silent',
  ]);
  assert.strictEqual(mixed?.approval, 'guardian');
  assert.strictEqual(mixed?.approvalAsk, 'deny');
  assert.strictEqual(mixed?.escalation, 'ask');
  assert.strictEqual(mixed?.elevatedSandbox, 'policy');
  assert.strictEqual(mixed?.modelAdapter, 'llamacpp');
  assert.strictEqual(mixed?.storageAdapter, 'sqlite');
  assert.strictEqual(mixed?.spillAdapter, 'memory');
  assert.strictEqual(mixed?.events, 'silent');
});

test('SandboxManager 未知 profile 返回 fail-closed 后端（不再回落 passthrough）', async () => {
  const manager = new SandboxManager(testRoot());
  const backend = manager.build('landock' as unknown as SandboxProfile);
  assert.strictEqual(backend.name, 'landock', '后端名回显传入值，便于定位配置错误');
  const decision = await backend.check({ kind: 'command', target: 'rm -rf /' });
  assert.strictEqual(decision.allowed, false, '未知 profile 必须拒绝，绝不通行');
  assert.strictEqual(decision.category, 'os');
  assert.match(decision.reason ?? '', /未知沙箱 profile/);
});

test('SandboxManager 合法 profile 仍映射到对应后端（回归）', () => {
  const manager = new SandboxManager(testRoot());
  assert.strictEqual(manager.build('passthrough').name, 'passthrough');
  assert.strictEqual(manager.build('policy').name, 'policy');
  assert.strictEqual(manager.build('restricted').name, 'restricted');
});
