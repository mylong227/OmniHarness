/**
 * 长时程状态协议判据（P0-2 / P1-2，2026-10-24）。
 *
 * 覆盖六类必须成立的语义：创建 / 恢复 / 损坏容错 / 路径越界 fail-closed /
 * feature 勾选 / verify 失败（含超时），外加「primer 极简」与 progress 归一。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LongHorizonProtocol,
  type LongHorizonVerifyResult,
} from '../../src/context/longHorizonProtocol.ts';

/** 建一个临时工作区（测试结束删）。 */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'omni-longhorizon-'));
}

/** 构造一个任务目录已 ensure 的协议实例。 */
function readyProtocol(
  root: string,
  overrides: Partial<ConstructorParameters<typeof LongHorizonProtocol>[0]> = {},
): LongHorizonProtocol {
  const protocol = new LongHorizonProtocol({
    workspaceRoot: root,
    slug: 'sess-test-1',
    title: '测试任务',
    verifyCommand: 'node -e "process.exit(0)"',
    seedFeatures: ['实现 A', '实现 B', '验证 A/B'],
    ...overrides,
  });
  const ensured = protocol.ensure();
  assert.strictEqual(ensured.ok, true, `ensure 失败：${ensured.reason ?? ''}`);
  return protocol;
}

test('创建：ensure 生成三件套（features/progress/init.sh + init.cmd），primer 含四类事实', () => {
  const root = workspace();
  try {
    const protocol = readyProtocol(root);
    const dir = protocol.taskDir;
    for (const name of ['features.json', 'progress.md', 'init.sh', 'init.cmd']) {
      assert.ok(existsSync(join(dir, name)), `缺少 ${name}`);
    }
    const features = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as {
      readonly features: readonly { readonly id: string; readonly description: string }[];
      readonly verifyCommand: string;
    };
    assert.deepStrictEqual(
      features.features.map((feature) => feature.id),
      ['F1', 'F2', 'F3'],
    );
    assert.strictEqual(features.verifyCommand, 'node -e "process.exit(0)"');
    const primer = protocol.renderPrimer();
    assert.match(primer, /【长时程任务】/u);
    assert.match(primer, /功能: 0\/3/u);
    assert.match(primer, /下一步: F1/u);
    assert.match(primer, /验证: node -e/u);
    // 极简：primer 不能变成历史倾倒（< 600 字符，且不含进度正文标题）。
    assert.ok(primer.length < 600, `primer 过长：${String(primer.length)}`);
    assert.ok(!primer.includes('## '), 'primer 不应包含 progress 正文');
    const init = readFileSync(join(dir, 'init.sh'), 'utf8');
    assert.match(init, /node -e "process\.exit\(0\)"/u);
    assert.match(init, /cd "\$\(dirname "\$0"\)\/\.\.\/\.\.\/\.\."/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('恢复：再次 ensure 保留 passes 与 progress，primer 反映已完成数', () => {
  const root = workspace();
  try {
    const first = readyProtocol(root);
    const marked = first.markFeature('F1', true);
    assert.strictEqual(marked.ok, true);
    assert.strictEqual(first.appendProgress('第一次进度'), true);

    const second = readyProtocol(root);
    const state = second.read();
    assert.strictEqual(state.features.find((feature) => feature.id === 'F1')?.passes, true);
    assert.match(second.renderPrimer(), /功能: 1\/3/u);
    const progress = readFileSync(join(second.taskDir, 'progress.md'), 'utf8');
    assert.match(progress, /第一次进度/u);
    assert.strictEqual((progress.match(/^## /gmu) ?? []).length, 1, '恢复不得重复写标题');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('损坏容错：坏 JSON 不抛、read 报 corrupt、ensure 备份后重建', () => {
  const root = workspace();
  try {
    const protocol = new LongHorizonProtocol({
      workspaceRoot: root,
      slug: 'sess-broken',
      seedFeatures: ['功能一'],
    });
    protocol.ensure();
    const featuresPath = join(protocol.taskDir, 'features.json');
    writeFileSync(featuresPath, '{not json', 'utf8');

    const broken = protocol.read();
    assert.strictEqual(broken.corrupt, true, '坏 JSON 必须标记 corrupt');
    assert.strictEqual(broken.initialized, false);
    assert.deepStrictEqual(broken.features, []);
    assert.strictEqual(protocol.renderPrimer(), '', '未初始化时不注入空 primer');

    const repaired = protocol.ensure();
    assert.strictEqual(repaired.ok, true);
    assert.strictEqual(repaired.repaired, true);
    assert.ok(
      readdirSync(protocol.taskDir).some((name) => name.includes('.corrupt-')),
      '损坏文件应被备份保留',
    );
    assert.strictEqual(protocol.read().corrupt, false, '修复后应可解析');
    assert.strictEqual(protocol.read().features.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路径越界 fail-closed：非法 slug 不写盘、不读盘、不执行', async () => {
  const root = workspace();
  try {
    for (const slug of ['../escape', 'a/b', '..', 'A-Upper', '', 'x'.repeat(65)]) {
      const protocol = new LongHorizonProtocol({ workspaceRoot: root, slug });
      assert.strictEqual(protocol.available, false, `slug 应被拒绝：${slug}`);
      assert.strictEqual(protocol.taskDir, '');
      const ensured = protocol.ensure();
      assert.strictEqual(ensured.ok, false);
      assert.strictEqual(protocol.appendProgress('x'), false);
      assert.strictEqual(protocol.markFeature('F1', true).ok, false);
      assert.deepStrictEqual(protocol.read().features, []);
      const verified: LongHorizonVerifyResult = await protocol.verify();
      assert.strictEqual(verified.ran, false);
    }
    assert.deepStrictEqual(readdirSync(root), [], '非法 slug 不得在工作区留下任何文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('feature 勾选：合法 id 原子更新，未知 id / 文件缺失 fail-closed', () => {
  const root = workspace();
  try {
    const protocol = readyProtocol(root);
    const updated = protocol.markFeature('F2', true);
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.feature?.id, 'F2');
    assert.strictEqual(updated.feature?.passes, true);
    const persisted = JSON.parse(readFileSync(join(protocol.taskDir, 'features.json'), 'utf8')) as {
      readonly features: readonly { readonly id: string; readonly passes: boolean }[];
    };
    assert.strictEqual(persisted.features.find((feature) => feature.id === 'F2')?.passes, true);
    const unknown = protocol.markFeature('F99', true);
    assert.strictEqual(unknown.ok, false);
    assert.match(String(unknown.reason), /未知功能 id/u);

    const missing = new LongHorizonProtocol({ workspaceRoot: root, slug: 'sess-missing' });
    const result = missing.markFeature('F1', true);
    assert.strictEqual(result.ok, false);
    assert.match(String(result.reason), /features\.json 缺失/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify：失败/通过/未配置/超时四态如实返回（不把未跑当成通过）', async () => {
  const root = workspace();
  try {
    const failing = readyProtocol(root, {
      slug: 'sess-verify-fail',
      verifyCommand: 'node -e "process.exit(2)"',
    });
    const failed = await failing.verify();
    assert.strictEqual(failed.ran, true);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.exitCode, 2);
    assert.strictEqual(failed.command, 'node -e "process.exit(2)"');

    const passing = readyProtocol(root, {
      slug: 'sess-verify-pass',
      verifyCommand: 'node -e "process.exit(0)"',
    });
    const passed = await passing.verify();
    assert.strictEqual(passed.ok, true);
    assert.strictEqual(passed.exitCode, 0);

    const unset = readyProtocol(root, { slug: 'sess-verify-none', verifyCommand: undefined });
    const notConfigured = await unset.verify();
    assert.strictEqual(notConfigured.ran, false);
    assert.match(String(notConfigured.error), /未配置 verifyCommand/u);

    const slow = readyProtocol(root, {
      slug: 'sess-verify-timeout',
      verifyCommand: 'node -e "setTimeout(() => {}, 5000)"',
      verifyTimeoutMs: 300,
    });
    const timedOut = await slow.verify();
    assert.strictEqual(timedOut.timedOut, true);
    assert.strictEqual(timedOut.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('progress 归一：长 prompt 压成一行并截断，工具失败/验证结论可读', () => {
  const root = workspace();
  try {
    const protocol = readyProtocol(root);
    const longPrompt = `第一步：\n${'很长的提示内容 '.repeat(200)}`;
    protocol.appendProgress({
      userPrompt: longPrompt,
      toolFailures: 2,
      failedTools: ['read_file', 'shell'],
      verify: 'failed',
      verifyDetail: 'exit=1',
      note: '回合结束',
    });
    const progress = readFileSync(join(protocol.taskDir, 'progress.md'), 'utf8');
    assert.match(progress, /- 用户提示: 第一步： 很长的提示内容/u);
    assert.ok(!progress.includes('很长的提示内容\n'), '用户提示必须压成一行');
    assert.ok(progress.length < 2_000, '长 prompt 必须被截断');
    assert.match(progress, /- 工具失败: 2（read_file, shell）/u);
    assert.match(progress, /- 验证: failed（exit=1）/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
