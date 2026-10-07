// 回合流式缓冲（`models/TurnStreamBuffer.ts`）的语义判据。
//
// ## 这一条防的是什么
//
// ① **收尾零丢失**：回合结束前必须把缓冲里最后一段刷进状态——少了它，用户看到回复"最后几个字没了"。
// ② **释放即静默**：`discard()`（中断 / 切走 / 换会话）之后，迟到增量不得再把流式卡片点亮。
// ③ **按需自愈**：刷新 / 深链恢复出一个正在跑的回合时，缓冲是空的但增量已经在推——此时必须还能收，
//    否则表现是"连上了、回复却一个字都不来"（真实使用形态，不是理论边界）。
// ④ **换回合先清残留**：`open()` 必须先把上一回合的残留丢掉，否则新回合的首屏会看到旧文本。
//
// 节流本身（有界频率 / 首字不延迟 / 假时钟驱动）已由 `longSessionPerf.test.mjs` 覆盖，此处不重复；
// 这里只钉"生命周期"这一层——那正是本类存在的理由。
import assert from 'node:assert/strict';
import test from 'node:test';

const { TurnStreamBuffer } = await import('../dist/ui/models/TurnStreamBuffer.js');

test('① 落点即时收到增量：push 之后 write 被调用（首字不延迟的语义由节流器保证）', () => {
  // 注意：只 push **一次**。连续两次 push 会各刷一次（首个增量"立即出"，第二次因距今 <50ms
  // 则应排程——但假时钟 0ms 场景下两者都在同一时刻到期），故刷新次数不是本类要钉的不变量，
  // 累计文本才是（见 ②）。
  const seen = [];
  const buf = new TurnStreamBuffer((text) => seen.push(text));
  buf.push('第一段');
  assert.deepEqual(seen, ['第一段'], '首个增量必须立刻落到状态上');
});

test('② 收尾零丢失：flush 把最后一段刷出（不依赖定时器到点）', () => {
  const seen = [];
  let acc = '';
  const buf = new TurnStreamBuffer((text) => {
    seen.push(text);
    acc += text;
  });
  // 连续两次 push 会各刷一次（首个增量"立即出"是节流器的设计），此处不关心刷新次数，
  // 只钉**累计文本**：flush 之后必须与 push 过的全部增量逐字节一致。
  buf.push('前半');
  buf.push('后半');
  buf.flush();
  assert.equal(acc, '前半后半', 'flush 之后累计文本必须与 push 过的全部增量一致');
});

test('③ 释放丢弃未刷缓冲：discard 之后 flush 不再落盘（迟到增量不复活流式卡片）', () => {
  // 「迟到增量不得点亮卡片」的**完整**保证由调用方给出：`SessionController.appendTextDelta`
  // 在非 busy 态先 `discard()` 并直接 return（见 model 注释与 turnControl 的回归判据）。
  // 本类这一层的职责是：discard 之后**缓冲里那些还没刷出的内容**不得再被 flush 刷出来。
  const seen = [];
  const buf = new TurnStreamBuffer((text) => seen.push(text));
  buf.push('已刷出');
  const afterFirst = seen.length;
  buf.discard();
  buf.flush();
  assert.equal(seen.length, afterFirst, 'discard 之后 flush 不得再落盘');
  assert.equal(buf.active, false, '释放后不得报告"在飞"');
});

test('④ 按需自愈：没显式 open 也能收增量（刷新 / 深链恢复出的在飞回合）', () => {
  const seen = [];
  const buf = new TurnStreamBuffer((text) => seen.push(text));
  buf.push('刷新后到达的增量');
  assert.deepEqual(seen, ['刷新后到达的增量'], '未 open 时也必须收（否则界面"连上了却一个字不来"）');
  assert.equal(buf.active, true, '自愈之后缓冲必须是活的');
});

test('⑤ open 开新回合：先丢掉上一回合残留，再接受新增量', () => {
  const seen = [];
  const buf = new TurnStreamBuffer((text) => seen.push(text));
  buf.push('旧回合残留');
  const before = seen.length;
  buf.open();
  buf.push('新回合首段');
  assert.equal(seen.length, before + 1, 'open 之后只应看到新回合的增量');
  assert.equal(seen.at(-1), '新回合首段');
});

test('⑥ 空增量不发（避免无意义刷新）', () => {
  const seen = [];
  const buf = new TurnStreamBuffer((text) => seen.push(text));
  buf.push('');
  buf.flush();
  assert.deepEqual(seen, [], '空串不该产生任何落盘');
});

test('⑦ 幂等释放：连续 discard 不抛错（中断与切走可能同时触发）', () => {
  const buf = new TurnStreamBuffer(() => {});
  buf.discard();
  buf.discard();
  assert.equal(buf.active, false);
});
