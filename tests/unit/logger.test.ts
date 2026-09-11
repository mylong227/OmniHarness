import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, type LogLevel, nextTraceId } from '../../src/util/logger.js';

function collector(minLevel: LogLevel = 'debug'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger(minLevel, (l) => lines.push(l)), lines };
}

test('级别过滤：低于 minLevel 的不输出', () => {
  const { logger, lines } = collector('info');
  logger.debug('should-drop');
  logger.info('keep');
  logger.warn('keep-warn');
  assert.strictEqual(lines.length, 2, 'debug 应被过滤');
  assert.match(lines[0]!, /"level":"info"/);
});

test('JSON 形状：含 ts/level/msg 且字段合并', () => {
  const { logger, lines } = collector();
  logger.error('boom', { code: 42 });
  const parsed = JSON.parse(lines[0]!);
  assert.strictEqual(parsed.level, 'error');
  assert.strictEqual(parsed.msg, 'boom');
  assert.strictEqual(parsed.code, 42);
  assert.ok(typeof parsed.ts === 'string' && parsed.ts.includes('T'), 'ts 应为 ISO');
});

test('traceId 经 withTrace 自动传播，无上下文则不带', () => {
  const { logger, lines } = collector();
  logger.info('no-trace');
  logger.withTrace('abc-123', () => {
    logger.info('with-trace');
  });
  assert.strictEqual(JSON.parse(lines[0]!).traceId, undefined, '无上下文不带 traceId');
  assert.strictEqual(JSON.parse(lines[1]!).traceId, 'abc-123', 'withTrace 内携带 traceId');
});

test('withTrace 跨 async 仍传播', async () => {
  const { logger, lines } = collector();
  await logger.withTrace('t-async', async () => {
    await Promise.resolve();
    logger.info('inside-async');
  });
  assert.strictEqual(JSON.parse(lines[0]!).traceId, 't-async');
});

test('nextTraceId：优先用注入值，否则生成随机值', () => {
  assert.strictEqual(nextTraceId('given'), 'given');
  const rnd = nextTraceId();
  assert.ok(typeof rnd === 'string' && rnd.length > 0 && rnd !== 'given');
});
