// 左栏「拖拽排序 + 归档」算术与接线门禁（零 DOM、确定性）。
//
// ## 覆盖什么
//
// ① `SessionOrder.move`：拖拽落点 → 一次数组移动（幂等：同 id / 未知 id 原样返回，不打断交互）；
// ② `SessionGrouper.groupByTime` 的**已归档**分组：归档会话不再混进今天/昨天，单独成组垫底；
// ③ 接线守卫：左栏必须把拖拽与归档接到控制器（`onArchive` / `onReorder` / `SessionOrder.move`）。
//
// 直跑：node --test web/test/sessionOrder.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { SessionOrder } = await import('../dist/ui/models/SessionOrder.js');
const { SessionGrouper } = await import('../dist/ui/models/SessionGrouper.js');

/** 造一条会话。 */
function row(id, updatedAt = '', archived = false) {
  return { id, updatedAt, archived };
}

test('move：把某行拖到另一行的位置（落点行被顶下去）', () => {
  const items = [row('a'), row('b'), row('c'), row('d')];
  assert.deepStrictEqual(
    SessionOrder.move(items, 'd', 'b').map((x) => x.id),
    ['a', 'd', 'b', 'c'],
  );
  assert.deepStrictEqual(
    SessionOrder.move(items, 'a', 'c').map((x) => x.id),
    ['b', 'c', 'a', 'd'],
  );
});

test('move：输入不被修改（返回新数组）', () => {
  const items = [row('a'), row('b')];
  const out = SessionOrder.move(items, 'a', 'b');
  assert.deepStrictEqual(items.map((x) => x.id), ['a', 'b'], '原数组必须保持不变');
  assert.notStrictEqual(out, items);
});

test('move：同 id / 未知 id / 空数组 ⇒ 原样返回（幂等，不抛错）', () => {
  const items = [row('a'), row('b')];
  assert.deepStrictEqual(SessionOrder.move(items, 'a', 'a').map((x) => x.id), ['a', 'b']);
  assert.deepStrictEqual(SessionOrder.move(items, 'zzz', 'a').map((x) => x.id), ['a', 'b']);
  assert.deepStrictEqual(SessionOrder.move(items, 'a', 'zzz').map((x) => x.id), ['a', 'b']);
  assert.deepStrictEqual(SessionOrder.move([], 'a', 'b'), []);
});

test('按时间分组：归档会话单独成组且垫底，不混进今天/昨天', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
  const today = new Date(2026, 8, 27, 9, 0, 0).toISOString();
  const groups = SessionGrouper.groupByTime(
    [row('t1', today), row('arch1', today, true), row('y1', new Date(2026, 8, 26, 9, 0, 0).toISOString())],
    now,
  );
  assert.deepStrictEqual(
    groups.map((g) => g.key),
    ['today', 'yesterday', 'archived'],
    '归档组必须存在且垫底',
  );
  assert.deepStrictEqual(
    groups.find((g) => g.key === 'today')?.items.map((x) => x.id),
    ['t1'],
    '归档会话不得留在「今天」组里',
  );
  assert.deepStrictEqual(
    groups.find((g) => g.key === 'archived')?.items.map((x) => x.id),
    ['arch1'],
  );
  assert.strictEqual(groups.find((g) => g.key === 'archived')?.name, '已归档');
});

test('移到顶部 / 移到底部：等价于「与首/末行交换位置」的一次移动', () => {
  const items = [row('a'), row('b'), row('c'), row('d')];
  const first = items[0];
  const last = items[items.length - 1];
  assert.deepStrictEqual(
    SessionOrder.move(items, 'c', first.id).map((x) => x.id),
    ['c', 'a', 'b', 'd'],
    '移到顶部 = 插到首行之前',
  );
  assert.deepStrictEqual(
    SessionOrder.move(items, 'b', last.id).map((x) => x.id),
    ['a', 'c', 'd', 'b'],
    '移到底部 = 插到末行之后',
  );
  // 已在首/末行时是幂等空操作（面板里直接 return，这里确认移动语义本身也不动）
  assert.deepStrictEqual(SessionOrder.move(items, 'a', 'a').map((x) => x.id), ['a', 'b', 'c', 'd']);
});

test('接线守卫：三个视图都可拖拽，右键菜单含「移到顶部 / 移到底部」', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const views = readFileSync(join(here, '..', 'src', 'ui', 'components', 'SessionViews.tsx'), 'utf8');
  const drags = views.match(/draggable=\{ctx\.onDragStart !== undefined\}/g) ?? [];
  assert.strictEqual(
    drags.length,
    3,
    `时间分组 / 按工作区分组 / 任务卡三个视图都必须可拖拽（实测 ${drags.length} 处）`,
  );
  const panel = readFileSync(join(here, '..', 'src', 'ui', 'components', 'SessionPanel.tsx'), 'utf8');
  assert.match(panel, /移到顶部/, '右键菜单必须有「移到顶部」');
  assert.match(panel, /移到底部/, '右键菜单必须有「移到底部」');
  assert.match(panel, /const moveToEdge = /, '移到底部/顶部必须走统一的 moveToEdge');
});

test('接线守卫：左栏把拖拽与归档都接到控制器（不得只画 UI 不接线）', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, '..', 'src', 'ui', 'components', 'SessionPanel.tsx'), 'utf8');
  const app = readFileSync(join(here, '..', 'src', 'ui', 'App.ts'), 'utf8');
  assert.match(panel, /SessionOrder\.move\(sessions, from, id\)/, '拖拽落点必须走 SessionOrder.move');
  assert.match(panel, /onDropOn: \(id: string\)/, '拖拽放下必须接线');
  assert.match(panel, /props\.onArchive/, '归档按钮必须接到 props.onArchive');
  assert.match(app, /onArchive: ctrl\.sessions\.archiveSession/, 'App 必须把归档接到会话控制器');
  assert.match(app, /onReorder: ctrl\.sessions\.reorderSessions/, 'App 必须把排序接到会话控制器');
});
