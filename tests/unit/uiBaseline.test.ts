/**
 * UI 结构基线的纯逻辑单测（不启动浏览器）。
 *
 * 基线机制本身必须可信，否则「视觉回归门禁」会变成两件坏事之一：假红（每次都被绕过）
 * 或假绿（什么都没抓）。故这里逐条钉住：规范化（空白/排序）、逐字段差异描述、读写往返，
 * 以及「有意改动会红、无关抖动不会红」这一对关键性质。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiBaseline } from '../integration/uiBaseline.js';
import type { UiSnapshot } from '../integration/uiBaseline.js';

/** 造一份基线快照。 */
function snapshot(overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    tabs: ['工具', '变更', '指标'],
    railItems: 11,
    composer: { placeholder: '输入任务，Enter 发送', sendLabel: '发送' },
    composerControls: ['附加图片、视频或文件', '开始语音输入', '发送任务'],
    emptyStates: ['等待任务', '暂无工具调用'],
    ...overrides,
  };
}

test('normalize：裁剪空白、剔除空项、空态文案排序（顺序不是契约）', () => {
  const normalized = UiBaseline.normalize({
    tabs: ['  工具  ', '', '变更'],
    railItems: 11,
    composer: { placeholder: '  输入任务，Enter   发送 ', sendLabel: ' 发送 ' },
    composerControls: ['发送任务', '   '],
    emptyStates: ['暂无工具调用', '等待任务'],
  });
  assert.deepStrictEqual(normalized.tabs, ['工具', '变更']);
  assert.strictEqual(normalized.composer.placeholder, '输入任务，Enter 发送');
  assert.strictEqual(normalized.composer.sendLabel, '发送');
  assert.deepStrictEqual(normalized.composerControls, ['发送任务']);
  // 排序后比较：空态文案的 DOM 顺序随面板开合变化，不应当成回归。
  // 排序用**代码单元序**（默认 sort）而非 localeCompare——后者随机器 ICU/区域设置变化，
  // 会让「基线」在不同机器上得出不同结果（正是本机制要避免的假红）。
  assert.deepStrictEqual(normalized.emptyStates, ['暂无工具调用', '等待任务']);
});

test('compare：一致时为 ok，且空态顺序不同不算差异', () => {
  const verdict = UiBaseline.compare(
    snapshot({ emptyStates: ['暂无工具调用', '等待任务'] }),
    snapshot(),
  );
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.diffs, []);
});

test('compare：逐字段给出人话差异（页签增删 / 控件名丢失 / 文案改动 / 图标栏数量）', () => {
  const verdict = UiBaseline.compare(
    snapshot({
      tabs: ['工具', '指标', '回滚'],
      composerControls: ['发送任务'],
      composer: { placeholder: '换个占位', sendLabel: '发送' },
      railItems: 9,
    }),
    snapshot(),
  );
  assert.strictEqual(verdict.ok, false);
  const joined = verdict.diffs.join('\n');
  assert.match(joined, /右栏页签 变化：新增 \["回滚"\] \/ 消失 \["变更"\]/);
  // 「消失」列表按基线顺序输出，不额外排序——故逐项断言，避免把顺序也当成契约。
  assert.match(joined, /输入区控件无障碍名 变化：新增 \[\] \/ 消失 \[/);
  assert.match(joined, /附加图片、视频或文件/);
  assert.match(joined, /开始语音输入/);
  assert.match(joined, /输入框占位文案变化/);
  assert.match(joined, /图标栏条目数 9 ≠ 基线 11/);
});

test('save/load：写入规范化结果且往返稳定（缩进 2 空格 + 结尾换行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-ui-baseline-'));
  try {
    const path = join(dir, 'uiBaseline.json');
    UiBaseline.save(path, snapshot({ tabs: [' 工具 ', '变更'] }));
    const text = readFileSync(path, 'utf8');
    assert.ok(text.endsWith('\n'), '基线文件应以换行结尾（便于 diff）');
    assert.match(text, /\n {2}"tabs"/, '应为 2 空格缩进 JSON');
    assert.deepStrictEqual(UiBaseline.load(path).tabs, ['工具', '变更']);
    // 往返稳定：load 再 save 不产生差异。
    UiBaseline.save(path, UiBaseline.load(path));
    assert.strictEqual(text, readFileSync(path, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture：从注入的求值器读取页面结构（不依赖真实浏览器）', async () => {
  const cdp = {
    evaluate: async (): Promise<unknown> => ({
      tabs: ['工具', ' 变更 '],
      railItems: 3,
      composer: { placeholder: ' 输入 ', sendLabel: '发送' },
      composerControls: ['发送任务'],
      emptyStates: ['等待任务'],
    }),
  };
  const captured = await UiBaseline.capture(cdp);
  assert.deepStrictEqual(captured.tabs, ['工具', '变更']);
  assert.strictEqual(captured.railItems, 3);
  assert.strictEqual(captured.composer.placeholder, '输入');
  assert.deepStrictEqual(captured.composerControls, ['发送任务']);
});

test('load：基线文件损坏时抛错（不静默当成空基线而放行一切）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-ui-baseline-bad-'));
  try {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');
    assert.throws(() => UiBaseline.load(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture 契约：页签来自 [role="tab"]、控件名来自 .composer button（防选择器漂移）', async () => {
  let expression = '';
  const cdp = {
    evaluate: async (js: string): Promise<unknown> => {
      expression = js;
      return { tabs: [], railItems: 0, composer: { placeholder: '', sendLabel: '' } };
    },
  };
  await UiBaseline.capture(cdp);
  assert.match(expression, /\[role="tab"\]/, '页签必须按 role=tab 采集（实测过的真实选择器）');
  assert.match(expression, /\.composer button/, '输入区控件必须按 .composer button 采集');
  assert.match(expression, /aria-label/, '控件名必须优先取 aria-label（无障碍契约的一部分）');
});
