// 左栏「按时间分组」（Codex 式：今天 / 昨天 / 更早）的算术门禁（零 DOM、确定性）。
//
// 口径：按**本地日历日**分桶；`updatedAt` 缺失或解析失败一律进「更早」（fail-closed 到可见分组，
// 不丢行）；组内保持输入顺序；空桶不产出。
//
// 直跑：node --test web/test/sessionTimeGrouping.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { SessionGrouper } = await import('../dist/ui/models/SessionGrouper.js');

/** 造一条会话（只需 id 与 updatedAt 参与分桶）。 */
function row(id, updatedAt) {
  return { id, updatedAt };
}

test('今天 / 昨天 / 更早 三桶，顺序固定且空桶不产出', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime(); // 本地 2026-09-27 15:00
  const rows = [
    row('a', new Date(2026, 8, 27, 9, 0, 0).toISOString()), // 今天
    row('b', new Date(2026, 8, 26, 23, 59, 0).toISOString()), // 昨天
    row('c', new Date(2026, 8, 20, 8, 0, 0).toISOString()), // 更早
    row('d', new Date(2026, 8, 27, 0, 0, 1).toISOString()), // 今天（零点刚过）
  ];
  const groups = SessionGrouper.groupByTime(rows, now);
  assert.deepStrictEqual(
    groups.map((g) => g.key),
    ['today', 'yesterday', 'earlier'],
  );
  assert.deepStrictEqual(
    groups.map((g) => g.items.map((x) => x.id)),
    [
      ['a', 'd'],
      ['b'],
      ['c'],
    ],
    '组内必须保持输入顺序（列表已按更新时间倒序）',
  );
  assert.deepStrictEqual(
    groups.map((g) => g.name),
    ['今天', '昨天', '更早'],
  );
});

test('只有今天的会话时，不产出空桶', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
  const groups = SessionGrouper.groupByTime([row('a', new Date(2026, 8, 27, 9, 0, 0).toISOString())], now);
  assert.deepStrictEqual(
    groups.map((g) => g.key),
    ['today'],
  );
});

test('缺失 / 非法 updatedAt 一律进「更早」（不丢行）', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
  const groups = SessionGrouper.groupByTime(
    [row('x', undefined), row('y', ''), row('z', '不是时间'), row('t', new Date(2026, 8, 27, 1, 0, 0).toISOString())],
    now,
  );
  const earlier = groups.find((g) => g.key === 'earlier');
  assert.ok(earlier !== undefined, '必须存在「更早」桶');
  assert.deepStrictEqual(
    earlier.items.map((x) => x.id),
    ['x', 'y', 'z'],
    '解析失败的行必须仍在列表里（只是归入更早）',
  );
  assert.deepStrictEqual(
    groups.find((g) => g.key === 'today')?.items.map((x) => x.id),
    ['t'],
  );
});

test('桶边界：本地零点归「今天」，其前一毫秒归「昨天」', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
  const midnight = new Date(2026, 8, 27, 0, 0, 0).getTime();
  const groups = SessionGrouper.groupByTime(
    [row('edge-today', new Date(midnight).toISOString()), row('edge-yesterday', new Date(midnight - 1).toISOString())],
    now,
  );
  assert.deepStrictEqual(
    groups.find((g) => g.key === 'today')?.items.map((x) => x.id),
    ['edge-today'],
  );
  assert.deepStrictEqual(
    groups.find((g) => g.key === 'yesterday')?.items.map((x) => x.id),
    ['edge-yesterday'],
  );
});

// 默认视图 2026-10-07 由「时间分组」改为「按项目分组」：用户报「会话没有按所属项目归类，切了新项目
// 还显示旧项目的会话」——按项目分组是这件事的正面回答（时间分组仍在三态循环里，一键可回）。
test('接线守卫：左栏默认按**项目**分组，且右键菜单已接上', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, '..', 'src', 'ui', 'components', 'SessionPanel.tsx'), 'utf8');
  assert.match(panel, /renderTimeGroupsView\(listCtx\)/, '左栏必须渲染时间分组视图');
  assert.match(panel, /useState<'time' \| 'ws' \| 'cards'>\('ws'\)/, '默认视图必须按项目分组');
  assert.match(panel, /renderGroupsView\(listCtx\)/, '默认视图必须真的渲染按项目分组');
  assert.match(panel, /renderTimeGroupsView\(listCtx\)/, '时间分组仍须保留（三态循环里可切回）');
  assert.match(panel, /onContextMenu: \(id: string, x: number, y: number\)/, '行右键菜单必须接线');
  assert.match(panel, /className="row-menu"/, '右键菜单必须渲染');
  assert.match(panel, /e\.key === '\['/, '`[` 快捷键必须收起/展开左栏');
});
