// 会话行可读性判据（2026-10-08 易用性轮）。
//
// ## 被改的形态（真机截图取证）
//
// 工作区里有 15 条会话，默认「按项目分组」视图里一行只渲染**截断到约 14 字**的标题，而悬停给的
// 是 `title={s.id}` ⇒ 客户看到的是 `sess_muxrgioa_b` 这种**内部 ID**（零信息）。截图里两条会话
// 完全同名（都是「先读取工作区里的...」），点哪条全靠试。「N 回合 · X 分钟前」只存在于**非默认**
// 的卡片视图里，客户不会去发现。
//
// ## 判据
//
// | # | 判据 | 反例形态（改了就会红） |
// |---|------|------------------------|
// | ① | 悬停给**完整**标题 + 最近活动 + 回合数，缺什么不编什么 | 退回 `title={s.id}`；把 turns 缺省写成 `0 回合` |
// | ② | 行内相对时间可注入时刻（受控 ⇒ 判据确定性）且无时间时不渲染 | 用墙钟算 ⇒ 毫秒跨界假红；无 updatedAt 时渲染空占位 |
// | ③ | **两个**分组视图共用同一套行渲染（不各写一份） | 只改「按项目」忘了「按时间」——本仓反复出现的漂移形态 |
// | ④ | 悬停时时间格**保留占位**（opacity 让位，而非 display:none） | 改成 display:none ⇒ 标题宽度在悬停瞬间跳变 |

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRowMeta } from '../dist/ui/models/SessionRowMeta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');

/** 受控参照时刻：`2026-06-06T12:00:00Z`。 */
const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

/**
 * 构造一条会话条目。
 * @param over 覆盖字段
 * @returns 会话条目
 */
function entry(over = {}) {
  return { id: 'sess_abc', label: '按项目分组', ...over };
}

test('① 悬停标题：完整标题 + 最近活动 + 回合数；缺什么不编什么', () => {
  const full = SessionRowMeta.hoverTitle(
    entry({ label: '先读取工作区里的任意一个文件并总结', updatedAt: new Date(NOW - 90 * 60000).toISOString(), turns: 3 }),
    NOW,
  );
  assert.equal(
    full,
    '先读取工作区里的任意一个文件并总结 · 1 小时前 · 3 回合 · sess_abc',
    '必须给**完整**标题（不截断）、最近活动、回合数与 id',
  );
  // 标题不会被截断：>14 字的标题必须逐字出现（行内是截断的，悬停是唯一能看到全文的地方）
  const long = 'x'.repeat(80);
  assert.ok(SessionRowMeta.hoverTitle(entry({ label: long }), NOW).startsWith(long), '标题不得被截断');
  // turns 缺省 ⇒ 不写「0 回合」（历史会话真的没有这个数字）
  const noTurns = SessionRowMeta.hoverTitle(entry({ label: 'A', updatedAt: new Date(NOW).toISOString() }), NOW);
  assert.equal(noTurns, 'A · 刚刚 · sess_abc');
  assert.ok(!noTurns.includes('回合'), 'turns 缺省时不得编造回合数');
  // updatedAt 不可解析 ⇒ 不写时间那一格，但标题与 id 仍在
  assert.equal(SessionRowMeta.hoverTitle(entry({ label: 'A', updatedAt: 'not-a-date' }), NOW), 'A · sess_abc');
  // 无标题（label 为空）⇒ 回落成 id，且**不重复**追加 id
  assert.equal(SessionRowMeta.hoverTitle(entry({ label: '' }), NOW), 'sess_abc');
  // 恒非空：即便字段全缺，也必须给出身份线索
  assert.equal(SessionRowMeta.hoverTitle({ id: 'sess_only', label: '' }, NOW), 'sess_only');
});

test('② 行内相对时间：受控时刻下确定、用紧凑形、无时间时不渲染', () => {
  const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
  // 紧凑形（这一格是从标题宽度里抠出来的，见 SessionRowMeta.inlineTime 的说明）
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: at(0) }), NOW), '刚刚');
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: at(3) }), NOW), '3分');
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: at(120) }), NOW), '2小时');
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: at(60 * 24 * 5) }), NOW), '5天');
  // 紧凑形必须**真的更短**：否则"为了标题宽度才改它"这条理由不成立
  for (const minutes of [3, 120, 60 * 24 * 5]) {
    const s = entry({ updatedAt: at(minutes) });
    assert.ok(
      SessionRowMeta.inlineTime(s, NOW).length < SessionRowMeta.hoverTitle(s, NOW).length,
      '行内时间必须比悬停文案短（否则挤压标题宽度）',
    );
  }
  // 无时间 / 坏时间 ⇒ 空串（调用点据此**不渲染**这一格，避免留下空的对齐占位）
  assert.equal(SessionRowMeta.inlineTime(entry(), NOW), '');
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: '' }), NOW), '');
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: 'not-a-date' }), NOW), '');
  // 未来时间不出现负数（时钟漂移下的稳健性）
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: new Date(NOW + 600000).toISOString() }), NOW), '刚刚');
  // 同一输入恒同输出（判据自身的可复现性）
  assert.equal(SessionRowMeta.inlineTime(entry({ updatedAt: at(3) }), NOW), SessionRowMeta.inlineTime(entry({ updatedAt: at(3) }), NOW));
  // 悬停文案里给的仍是**完整形**（信息一点没少）
  assert.match(SessionRowMeta.hoverTitle(entry({ updatedAt: at(120) }), NOW), /2 小时前/, '悬停必须给完整相对时间');
});

test('③ 接线：三个视图共用同一套行渲染，且不再把内部 ID 当悬停文案', () => {
  const views = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'SessionViews.tsx'), 'utf8');
  // 悬停文案必须走 SessionRowMeta（原先 `title={s.id}` ⇒ 客户看到 `sess_xxx`）
  assert.ok(
    !/title=\{s\.id\}/.test(views),
    '不得再出现 title={s.id}（悬停显示内部 ID 对客户零信息）',
  );
  const hoverCalls = views.match(/title=\{SessionRowMeta\.hoverTitle\(s, now\)\}/g) ?? [];
  assert.equal(hoverCalls.length, 3, `三个视图都必须给完整悬停文案，实际 ${hoverCalls.length} 处`);
  // 两个分组视图都要有行内时间：`renderGroupsView` 与 `renderTimeGroupsView` 各一处
  const timeCalls = views.match(/\{renderSessionTime\(s, now\)\}/g) ?? [];
  assert.equal(timeCalls.length, 2, `两个分组视图都必须有行内时间，实际 ${timeCalls.length} 处`);
  assert.match(views, /export function renderGroupsView\(ctx: ListCtx, now: number = Date\.now\(\)\)/, '按项目视图必须接受注入时刻');
  assert.match(views, /export function renderTimeGroupsView\(ctx: ListCtx, now: number = Date\.now\(\)\)/, '按时间视图必须接受注入时刻');
  assert.match(views, /export function renderCardsView\(ctx: ListCtx, now: number = Date\.now\(\)\)/, '卡片视图必须接受注入时刻');
  // 卡片视图已有自己的 `tc-meta`，不得再叠一个（否则同一行出现两个时间）
  const cards = views.slice(views.indexOf('renderCardsView'), views.indexOf('renderGroupsView'));
  assert.ok(!cards.includes('renderSessionTime'), '卡片视图已有 tc-meta 时间，不得重复渲染');
});

test('④ 样式：时间格保留占位、操作按钮不占位（真机像素取证的反向约束）', () => {
  const css = readFileSync(join(WEB_ROOT, 'styles', 'polish.css'), 'utf8');
  const rule = /\.session-time\s*\{[^}]*\}/.exec(css);
  assert.ok(rule !== null, '.session-time 规则必须存在（否则行内时间没有样式，会挤坏标题）');
  assert.match(rule[0], /flex:\s*0 0 auto/, '时间格不得被压缩（会与标题抢宽度）');
  const hover = /\.session:hover\s+\.session-time\s*\{[^}]*\}/.exec(css);
  assert.ok(hover !== null, '必须有 hover 让位规则（给重命名 / 复制 / 删除按钮腾出位置）');
  assert.match(hover[0], /opacity:\s*0/, '让位必须用 opacity（保留占位 ⇒ 悬停前后零位移）');
  assert.ok(!/display:\s*none/.test(hover[0]), '不得用 display:none：那会让标题宽度在悬停瞬间跳变');

  // 真机实测（2026-10-08，248px 侧栏）：三个操作按钮以 opacity:0 **常驻占位 86px**，
  // 标题只剩 73–91px（约 6 字）。改成覆盖层后标题回到 165–183px。这条防它被改回占位形态。
  const actions = /\.session\s+\.session-actions,\s*\n?\s*\.task-card\s+\.session-actions\s*\{[^}]*\}/.exec(css);
  assert.ok(actions !== null, '操作按钮的覆盖层规则必须存在（否则又会吃掉 86px 标题宽度）');
  assert.match(actions[0], /position:\s*absolute/, '操作按钮必须是绝对定位的覆盖层（不参与行内布局）');
  assert.match(actions[0], /right:\s*8px/, '覆盖层必须贴右缘');
  // 覆盖层自带底色：否则会与标题尾巴糊在一起（这是覆盖层方案的代价，必须显式还上）
  assert.match(css, /\.session\s+\.session-actions\s*\{[^}]*background:/, '覆盖层必须有不透明底色');
});
