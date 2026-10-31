// 插话相关性判定 + steering 多模态队列（2026-10-31「插话模式」）的纯逻辑判据。
//
// 判定的代价在**误判**：
//   · 把无关任务当补充 ⇒ 用户的新任务被并进旧任务上下文，永远等不到开始；
//   · 把补充当无关 ⇒ 在跑的活被无故打断，前面的工具探索全白费。
// 这里用真实用户会说的句子钉住两个方向，并覆盖「纯附件补充」这一第三方情形。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { InterjectionClassifier } from '../../src/core/steering/interjectionClassifier.ts';
import { SteeringQueue } from '../../src/core/steering/steeringQueue.ts';
import type { SessionEvent } from '../../src/ports/runtime/event/sessionEvent.ts';

/**
 * 造一条会话事件（只填判定器会读的字段）。
 * @param type 事件类型
 * @param content 文本内容
 * @param id 事件 id
 * @returns 会话事件
 */
function event(
  type: 'user' | 'assistant' | 'system' | 'tool_result',
  content: string,
  id: string,
): SessionEvent {
  return {
    id,
    type,
    sessionId: 's1',
    timestamp: '2026-10-31T00:00:00.000Z',
    payload: { content },
  };
}

test('contextOf：只取 user/assistant 的 content，按时间正序，忽略工具与系统事件', () => {
  const events: SessionEvent[] = [
    event('user', '把 a.ts 里的 readFile 改成异步', '1'),
    event('assistant', '好的，先读文件', '2'),
    event('tool_result', 'body', '3'),
    event('system', '【预算提醒】', '4'),
  ];
  assert.deepStrictEqual(InterjectionClassifier.contextOf(events), [
    '把 a.ts 里的 readFile 改成异步',
    '好的，先读文件',
  ]);
});

test('相关：纠正 / 补充 / 追问都判为并入当前任务', () => {
  const context = ['把 a.ts 里的 readFile 改成异步', '已完成第一处修改'];
  const correction = InterjectionClassifier.classify('不对，应该用 b.ts 而不是 a.ts', context);
  assert.strictEqual(correction.related, true, '纠正应并入');
  const supplement = InterjectionClassifier.classify('补充一下，还要处理空输入', context);
  assert.strictEqual(supplement.related, true, '补充应并入');
  const followUp = InterjectionClassifier.classify('继续，把测试也补上', context);
  assert.strictEqual(followUp.related, true, '追问/继续应并入');
});

test('相关：短确认句并入（不能把「好的/继续」当成新任务把活杀掉）', () => {
  const context = ['实现 parse(input) 函数'];
  for (const text of ['好的', '继续', '可以', 'ok', '收到']) {
    assert.strictEqual(
      InterjectionClassifier.classify(text, context).related,
      true,
      `「${text}」应判为相关`,
    );
  }
});

test('无关：真正的新话题必须判为打断（不靠「帮我/一下」这类虚词误判）', () => {
  const context = ['把 a.ts 里的 readFile 改成异步', '已完成第一处修改'];
  const weather = InterjectionClassifier.classify('帮我查一下明天北京的天气', context);
  assert.strictEqual(weather.related, false, '换话题应打断');
  assert.strictEqual(weather.reason, 'new-topic');
  const crawl = InterjectionClassifier.classify('写一个爬取商品价格的脚本', context);
  assert.strictEqual(crawl.related, false);
});

test('无关：显式打断词优先级最高（即使与上下文有词面重合）', () => {
  const context = ['把 a.ts 里的 readFile 改成异步'];
  const decision = InterjectionClassifier.classify('算了，不做了，换个任务', context);
  assert.strictEqual(decision.related, false);
  assert.strictEqual(decision.reason, 'interrupt-marker');
  const stop = InterjectionClassifier.classify('停止，先处理登录页', context);
  assert.strictEqual(stop.related, false, '「停止」必须能打断（即使提到同一个文件）');
});

test('相关：仅靠话题词重合也能判为补充（无显式关联词）', () => {
  const context = ['实现 parse(input) 函数', '补上单元测试'];
  const decision = InterjectionClassifier.classify('测试用例也要补', context);
  assert.strictEqual(decision.related, true);
  assert.strictEqual(decision.reason, 'lexical-overlap');
  assert.ok(decision.score > 0);
});

test('纯附件补充（空文本）视为相关：附件随 steering 一起并入', () => {
  const decision = InterjectionClassifier.classify('   ', ['重构设置页']);
  assert.strictEqual(decision.related, true);
  assert.strictEqual(decision.reason, 'attachment-only');
});

test('SteeringQueue：文本 / 多模态项都按会话入队出队；空内容不入队', () => {
  const queue = new SteeringQueue();
  assert.strictEqual(queue.enqueue('s1', '改方向：先跑测试'), true, '纯文本保持向后兼容');
  assert.strictEqual(queue.enqueue('s1', { text: '' }), false, '空内容不入队');
  assert.strictEqual(
    queue.enqueue('s1', {
      text: '补充证据',
      images: [{ mediaType: 'image/gif', data: 'GGGG' }],
      files: [{ name: 'log.txt', mediaType: 'text/plain', data: 'LOG' }],
    }),
    true,
  );
  assert.strictEqual(queue.size('s1'), 2);
  assert.deepStrictEqual(queue.take('s1'), { text: '改方向：先跑测试' });
  const item = queue.take('s1');
  assert.strictEqual(item?.text, '补充证据');
  assert.strictEqual(item?.images?.[0]?.mediaType, 'image/gif');
  assert.strictEqual(item?.files?.[0]?.name, 'log.txt');
  assert.strictEqual(queue.take('s1'), undefined);
  // 会话隔离 + 清空
  queue.enqueue('s1', 'a');
  queue.enqueue('s2', 'b');
  assert.strictEqual(queue.clear('s1'), 1);
  assert.strictEqual(queue.size('s1'), 0);
  assert.strictEqual(queue.size('s2'), 1, '清空只影响目标会话');
});
