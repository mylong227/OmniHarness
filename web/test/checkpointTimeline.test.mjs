// 检查点时间线（A2）：按天分组 / 相对时间 / 徽标 / 最新标记，以及回滚面板的键盘可达与确认闭环。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。
//
// 时间基准一律注入（now），不用 Date.now()：相对时间是输入的函数，混进真实时钟会让测试
// 在跨分钟/跨天时随机变红（测试一旦随机红，团队就会去关掉它）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();
const { CheckpointTimeline } = await import('../dist/ui/models/CheckpointTimeline.js');
const { TimestampFormatter } = await import('../dist/ui/models/checkpoint.js');
const { RollbackTab } = await import('../dist/ui/components/tabs/RollbackTab.js');

/** 本地时间构造（dayKey 用本地日期，用 UTC 串会把测试绑死在某个时区）。 */
function at(y, m, d, hh = 0, mm = 0) {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** 基准时刻：2026-09-20 12:00 本地。 */
const NOW = at(2026, 9, 20, 12, 0);

/** 距 NOW 偏移若干分钟的时间戳（ISO）。 */
function agoIso(minutes) {
  return new Date(NOW.getTime() - minutes * 60000).toISOString();
}

/** 造一个检查点。 */
function cp(label, minutes, eventCount, hasFileSnapshot) {
  return { label, ts: agoIso(minutes), eventCount, hasFileSnapshot };
}

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/** 收集整棵树的文本叶子。 */
function texts(vnode, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) texts(k, out);
    return out;
  }
  if (vnode == null) return out;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    out.push(String(vnode));
    return out;
  }
  if (typeof vnode !== 'object') return out;
  for (const k of vnode.children ?? []) texts(k, out);
  return out;
}

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

// ---- 模型层 ----

test('CheckpointTimeline.relative：分 / 时 / 天 / 超 7 天回退绝对时间', () => {
  const r = (minutes) => CheckpointTimeline.relative(agoIso(minutes), NOW);
  assert.strictEqual(r(0), '刚刚');
  assert.strictEqual(r(0.5), '刚刚');
  assert.strictEqual(r(1), '1 分钟前');
  assert.strictEqual(r(59), '59 分钟前');
  assert.strictEqual(r(60), '1 小时前');
  assert.strictEqual(r(23 * 60), '23 小时前');
  assert.strictEqual(r(25 * 60), '1 天前');
  assert.strictEqual(r(6 * 24 * 60), '6 天前');
  const far = CheckpointTimeline.relative(agoIso(8 * 24 * 60), NOW);
  assert.strictEqual(
    far,
    TimestampFormatter.format(agoIso(8 * 24 * 60), 'zh-CN'),
    '超 7 天走绝对时间',
  );
  assert.doesNotMatch(far, /前|刚刚/);
});

test('CheckpointTimeline.relative：非法时间戳原样返回（fail-closed 到可见原文）', () => {
  assert.strictEqual(CheckpointTimeline.relative('not-a-date', NOW), 'not-a-date');
  assert.strictEqual(CheckpointTimeline.parse('not-a-date'), null);
  assert.strictEqual(
    CheckpointTimeline.parse('2026-09-20T00:00:00.000Z'),
    Date.parse('2026-09-20T00:00:00.000Z'),
  );
});

test('CheckpointTimeline.dayKey / dayTitle：本地日期分组，今天/昨天有专名', () => {
  assert.strictEqual(CheckpointTimeline.dayKey(at(2026, 9, 20, 23, 59)), '2026-09-20');
  assert.strictEqual(CheckpointTimeline.dayKey(at(2026, 9, 1, 0, 1)), '2026-09-01');
  assert.strictEqual(CheckpointTimeline.dayTitle('2026-09-20', NOW), '今天');
  assert.strictEqual(CheckpointTimeline.dayTitle('2026-09-19', NOW), '昨天');
  assert.strictEqual(CheckpointTimeline.dayTitle('2026-09-17', NOW), '2026-09-17');
  assert.strictEqual(CheckpointTimeline.dayTitle('unknown', NOW), '时间未知');
});

test('CheckpointTimeline.sortDesc：时间倒序、非法垫底、同刻按 label（总序，与输入顺序无关）', () => {
  const items = [cp('b', 10, 1, false), cp('a', 10, 1, false), cp('old', 3000, 1, false)];
  assert.deepStrictEqual(
    CheckpointTimeline.sortDesc(items).map((c) => c.label),
    ['a', 'b', 'old'],
  );
  const withBad = [...items, { label: 'bad', ts: 'nope', eventCount: 0, hasFileSnapshot: false }];
  assert.deepStrictEqual(
    CheckpointTimeline.sortDesc([...withBad].reverse()).map((c) => c.label),
    CheckpointTimeline.sortDesc(withBad).map((c) => c.label),
    '打乱输入必须同序',
  );
  assert.strictEqual(CheckpointTimeline.sortDesc(withBad).at(-1).label, 'bad', '非法时间垫底');
});

test('CheckpointTimeline.build：按天分组、组内新在前、最新标记唯一、徽标与事件数就位', () => {
  const list = [
    cp('cp-old', 25 * 60, 3, false), // 昨天
    cp('cp-new', 5, 12, true), // 今天（最新）
    cp('cp-mid', 60, 7, true), // 今天
  ];
  const days = CheckpointTimeline.build(list, NOW);
  assert.strictEqual(days.length, 2);
  assert.strictEqual(days[0].key, '2026-09-20');
  assert.strictEqual(days[0].title, '今天');
  assert.deepStrictEqual(
    days[0].items.map((e) => e.meta.label),
    ['cp-new', 'cp-mid'],
  );
  assert.strictEqual(days[1].title, '昨天');
  assert.deepStrictEqual(
    days[1].items.map((e) => e.meta.label),
    ['cp-old'],
  );

  const entries = days.flatMap((d) => d.items);
  assert.strictEqual(entries.filter((e) => e.latest).length, 1, '最新标记有且仅有 1 个');
  assert.strictEqual(entries[0].latest, true);
  assert.deepStrictEqual(
    entries.map((e) => [e.eventCount, e.hasSnapshot, e.relative]),
    [
      [12, true, '5 分钟前'],
      [7, true, '1 小时前'],
      [3, false, '1 天前'],
    ],
  );
  assert.strictEqual(entries[0].absolute, TimestampFormatter.format(list[1].ts, 'zh-CN'));
});

test('CheckpointTimeline.build：空输入返回空时间线；非法时间归「时间未知」组', () => {
  assert.deepStrictEqual(CheckpointTimeline.build([], NOW), []);
  const days = CheckpointTimeline.build(
    [cp('ok', 5, 1, false), { label: 'bad', ts: '', eventCount: 0, hasFileSnapshot: false }],
    NOW,
  );
  assert.deepStrictEqual(
    days.map((d) => d.title),
    ['今天', '时间未知'],
  );
  assert.strictEqual(days[1].items[0].relative, '', '非法时间原样展示');
});

// ---- 组件层：回滚面板时间线 ----

/**
 * 渲染一次回滚面板（桩 api / dialog）。
 * 组件内部的时间基准是真实时钟（`new Date()`），故这里的桩数据也按真实时钟往前推，
 * 相对时间才落在确定的档位上（5 / 30 分钟前）。
 * @returns 渲染产物与调用记录
 */
function setupTab() {
  const calls = { rollbacks: [], confirms: 0, toasts: [] };
  const realNow = Date.now();
  const minutesAgo = (min) => new Date(realNow - min * 60000).toISOString();
  const list = [
    { label: 'cp-new', ts: minutesAgo(5), eventCount: 12, hasFileSnapshot: true },
    { label: 'cp-old', ts: minutesAgo(30), eventCount: 3, hasFileSnapshot: false },
  ];
  runtime.appContext.api = {
    async listCheckpoints() {
      return { checkpoints: list };
    },
    async rollbackCheckpoint(sessionId, label) {
      calls.rollbacks.push({ sessionId, label });
      return { checkpoint: { label: label ?? 'cp-new' } };
    },
    async createCheckpoint() {
      return { checkpoint: { label: 'cp-x' } };
    },
  };
  runtime.appContext.dialog = {
    async confirm() {
      calls.confirms += 1;
      return true;
    },
    async prompt() {
      return null;
    },
  };
  runtime.appContext.toast = (m, k) => calls.toasts.push({ m, k });
  runtime.reset();
  const vnode = runtime.render(
    RollbackTab,
    { sessionId: 's-1', onRolledBack: () => {} },
    {
      0: list,
      1: false,
      2: null,
      3: '',
      4: false,
    },
  );
  return { vnode, calls };
}

test('RollbackTab：按天分组渲染、徽标区分「含文件快照 / 仅对话」、最新点有标记', () => {
  const { vnode } = setupTab();
  const dayTitles = collect(vnode, (n) => n.props.className === 'cp-day-title');
  assert.strictEqual(dayTitles.length, 1, '两个检查点（5 / 30 分钟前）同属一天');
  assert.match(texts(dayTitles[0]).join(''), /^(今天|昨天)$/, '分组标题必须是今天/昨天');

  const badgeTexts = collect(
    vnode,
    (n) => typeof n.props.className === 'string' && n.props.className.startsWith('cp-badge'),
  ).map((b) => texts(b).join(''));
  assert.deepStrictEqual(badgeTexts, ['含文件快照', '仅对话']);

  const latest = collect(vnode, (n) => n.props.className === 'cp-latest');
  assert.strictEqual(latest.length, 1, '最新标记必须唯一');
  const items = collect(vnode, (n) => n.props.className.startsWith('cp-item'));
  assert.ok(items[0].props.className.includes('latest'), '最新标记必须落在最新那条上');

  // 文本叶子必须无缝拼接：`{e.eventCount} 事件` 是两个兄弟文本节点，用分隔符拼会拆散「12 事件」。
  const all = texts(vnode).join('');
  assert.match(all, /12 事件/, '条目必须展示事件数');
  assert.match(all, /3 事件/);
  assert.match(all, /5 分钟前/, '条目必须展示相对时间');
  assert.match(all, /30 分钟前/);
});

test('RollbackTab：条目是 button（Tab 可达），aria-label 含标签/相对时间/事件数/快照', () => {
  const { vnode } = setupTab();
  assert.strictEqual(collect(vnode, (n) => n.props.role === 'list').length, 1, '时间线须是 list');
  const listItems = collect(vnode, (n) => n.props.role === 'listitem');
  assert.strictEqual(listItems.length, 2);
  const btns = collect(vnode, (n) => n.type === 'button' && n.props.className === 'cp-main');
  assert.strictEqual(btns.length, 2, '每条检查点一个可聚焦按钮');
  assert.strictEqual(
    btns[0].props['aria-label'],
    '回滚到检查点 cp-new（5 分钟前，12 个事件，含文件快照）',
  );
  assert.strictEqual(
    btns[1].props['aria-label'],
    '回滚到检查点 cp-old（30 分钟前，3 个事件，仅对话）',
  );
  assert.strictEqual(btns[0].props['aria-current'], 'true', '最新点标 aria-current');
  assert.strictEqual(btns[1].props['aria-current'], undefined);
  assert.match(String(btns[0].props.title), /需确认/);
});

test('RollbackTab：点条目 / Enter 触发回滚，且必须先经对话框确认', async () => {
  const { vnode, calls } = setupTab();
  const btns = collect(
    vnode,
    (n) => typeof n.props.className === 'string' && n.props.className === 'cp-main',
  );
  btns[1].props.onClick();
  await flush();
  assert.strictEqual(calls.confirms, 1, '回滚前必须确认（Enter 与点击同一条路径）');
  assert.deepStrictEqual(calls.rollbacks, [{ sessionId: 's-1', label: 'cp-old' }]);
  assert.deepStrictEqual(calls.toasts[0], { m: '已回滚到：cp-old', k: 'ok' });
});

test('RollbackTab：确认框被拒绝时不发回滚请求（决策不静默产生）', async () => {
  const { vnode, calls } = setupTab();
  runtime.appContext.dialog.confirm = async () => false;
  const btns = collect(
    vnode,
    (n) => typeof n.props.className === 'string' && n.props.className === 'cp-main',
  );
  btns[0].props.onClick();
  await flush();
  assert.deepStrictEqual(calls.rollbacks, []);
  assert.deepStrictEqual(calls.toasts, []);
});

test('RollbackTab：无会话时不渲染时间线（fail-closed 到引导文案）', () => {
  runtime.reset();
  const vnode = runtime.render(RollbackTab, { sessionId: null, onRolledBack: () => {} });
  assert.strictEqual(collect(vnode, (n) => n.props.role === 'list').length, 0);
  assert.ok(
    texts(vnode).some((t) => t.includes('先选择一个会话')),
    '必须给出可操作的引导',
  );
});
