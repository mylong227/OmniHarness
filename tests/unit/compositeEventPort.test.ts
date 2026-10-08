/**
 * 事件端口扇出的判据（2026-10-08）。
 *
 * serve 里「控制台可读 + 客户端实时流」两个出口必须**同时**收到事件，且互不拖累：一个出口抛错
 * （客户端断开时 `send` 炸、OTLP 抖动）不得让另一个出口丢事件，更不得把回合打断。这条在真机上
 * 的代价很高（要复现「客户端断开瞬间」），故在这里用两个假出口钉死语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompositeEventPort } from '../../src/adapters/event/compositeEventPort.js';
import { CliEventPort } from '../../src/cli/cliEventPort.js';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { CliArgs } from '../../src/cli/argParser.js';

/** 一个事件样本（字段足够表达类型即可）。 */
const EVENT = {
  id: 'evt_probe_1',
  type: 'question',
  sessionId: 's1',
  timestamp: 1,
  payload: { questions: [] },
} as unknown as SessionEvent;

test('CompositeEventPort：事件扇出到全部成员，name 记录成员构成', () => {
  const seen: string[] = [];
  const composite = new CompositeEventPort([
    { name: 'console', emit: () => seen.push('console') },
    { name: 'server', emit: () => seen.push('server') },
  ]);
  assert.strictEqual(composite.name, 'composite:console+server');
  composite.emit(EVENT);
  assert.deepStrictEqual(seen, ['console', 'server'], '按构造顺序扇出');
});

test('CompositeEventPort：单个成员抛错只丢它自己，其余成员照常收到（fail-soft）', () => {
  const seen: string[] = [];
  const composite = new CompositeEventPort([
    {
      name: 'boom',
      emit: () => {
        throw new Error('客户端已断开');
      },
    },
    { name: 'server', emit: () => seen.push('server') },
  ]);
  assert.doesNotThrow(
    () => composite.emit(EVENT),
    '一个出口抛错不得打断调用方（回合不许被观测出口拖死）',
  );
  assert.deepStrictEqual(seen, ['server'], '后续成员必须仍然收到事件');
});

test('CompositeEventPort：flush 只冲刷有缓冲的成员，且单成员失败不外抛', async () => {
  let flushed = 0;
  const ports: EventPort[] = [
    { name: 'plain', emit: () => undefined },
    {
      name: 'buffered',
      emit: () => undefined,
      flush: async () => {
        flushed += 1;
      },
    },
    {
      name: 'bad',
      emit: () => undefined,
      flush: async () => {
        throw new Error('导出抖动');
      },
    },
  ];
  const composite = new CompositeEventPort(ports);
  await composite.flush();
  assert.strictEqual(flushed, 1, '有 flush 的成员必须被冲刷');
  assert.strictEqual(new CompositeEventPort([]).name, 'composite:', '空成员集合合法（等价静默）');
});

test('CliEventPort：--events 语义与 serve 的追加出口组合正确', () => {
  const asArgs = (events: 'console' | 'silent'): CliArgs => ({ events }) as CliArgs;
  const extra: EventPort = { name: 'server', emit: () => undefined };
  // 缺省（也是 'console'）：控制台与客户端**并存**——serve 的客户端出口不许被控制台挤掉。
  assert.strictEqual(CliEventPort.of(asArgs('console'), extra).name, 'composite:console+server');
  // 显式静默：静默只是「不要控制台输出」的占位，客户端出口照常生效。
  assert.strictEqual(CliEventPort.of(asArgs('silent'), extra).name, 'server');
  // 无追加出口（exec / TUI 等非 serve 路径）：行为与旧实现逐字一致。
  assert.strictEqual(CliEventPort.of(asArgs('console')).name, 'console');
  assert.strictEqual(CliEventPort.of(asArgs('silent')).name, 'silent');
});
