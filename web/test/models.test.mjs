// 领域模型单测：验证「业务逻辑抽成 class」后的纯逻辑正确性（零 React 依赖，node 直跑）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandPaletteModel } from '../dist/ui/models/CommandPaletteModel.js';
import { CheckpointNamer, TimestampFormatter } from '../dist/ui/models/checkpoint.js';

const CMDS = [
  { id: '1', label: '打开面板：工具', hint: 'Ctrl+1', group: '面板', run: () => {} },
  { id: '2', label: '打开面板：指标', hint: 'Ctrl+2', group: '面板', run: () => {} },
  { id: '3', label: '新建会话', hint: 'Ctrl+N', group: '会话', run: () => {} },
];

test('CommandPaletteModel 空查询返回全部命令', () => {
  const m = new CommandPaletteModel(CMDS);
  assert.equal(m.filter('').length, 3);
  assert.equal(m.filter('   ').length, 3);
  assert.equal(m.size, 3);
});

test('CommandPaletteModel 按 label 过滤且大小写无关', () => {
  const m = new CommandPaletteModel(CMDS);
  assert.equal(m.filter('指标').length, 1);
  assert.equal(m.filter('新建').length, 1);
  assert.equal(m.filter('不存在的命令').length, 0);
});

test('CommandPaletteModel 可命中 hint 与 group', () => {
  const m = new CommandPaletteModel(CMDS);
  assert.equal(m.filter('Ctrl+2').length, 1, '应命中 hint');
  assert.equal(m.filter('会话').length, 1, '应命中 group');
});

test('CommandPaletteModel filter 返回副本，不泄漏内部数组', () => {
  const m = new CommandPaletteModel(CMDS);
  const out = m.filter('');
  out.push({ id: 'x', label: '污染项', run: () => {} });
  assert.equal(m.size, 3);
});

test('CommandPaletteModel clamp 越界归零、负数归零、上限夹紧', () => {
  const m = new CommandPaletteModel(CMDS);
  assert.equal(m.clamp(5, 3), 2);
  assert.equal(m.clamp(1, 3), 1);
  assert.equal(m.clamp(-1, 3), 0);
  assert.equal(m.clamp(0, 0), 0, '空列表一律 0');
});

test('CommandPaletteModel move 上下移动且不越界', () => {
  const m = new CommandPaletteModel(CMDS);
  assert.equal(m.move(0, 3, 1), 1);
  assert.equal(m.move(2, 3, 1), 2, '已在底部则保持');
  assert.equal(m.move(0, 3, -1), 0, '已在顶部则保持');
});

test('CheckpointNamer 留空生成时间戳名，有输入用输入', () => {
  const fixed = new Date('2026-09-10T08:30:45.000Z');
  assert.equal(CheckpointNamer.resolve('   ', fixed), CheckpointNamer.auto(fixed));
  assert.match(CheckpointNamer.auto(fixed), /^checkpoint-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  assert.equal(CheckpointNamer.resolve('  我的检查点  ', fixed), '我的检查点');
  assert.equal(CheckpointNamer.resolve('', fixed), CheckpointNamer.auto(fixed));
});

test('TimestampFormatter 非法时间原样返回（fail-closed）', () => {
  assert.equal(TimestampFormatter.format('not-a-date'), 'not-a-date');
  const ok = TimestampFormatter.format('2026-09-10T08:30:45.000Z');
  assert.ok(ok.length > 0 && ok !== 'not-a-date');
});
