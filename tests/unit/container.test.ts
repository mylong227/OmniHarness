import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../../src/core/container.js';

test('容器：注册与获取', () => {
  const container = new Container();
  container.register('a', 42);
  assert.strictEqual(container.get<number>('a'), 42);
  assert.strictEqual(container.has('a'), true);
});

test('容器：重复注册抛错', () => {
  const container = new Container();
  container.register('a', 1);
  assert.throws(() => container.register('a', 2), /重复注册/);
});

test('容器：覆盖后可取新值', () => {
  const container = new Container();
  container.register('a', 1);
  container.overwrite('a', 2);
  assert.strictEqual(container.get<number>('a'), 2);
});

test('容器：获取未注册服务抛错', () => {
  const container = new Container();
  assert.throws(() => container.get('missing'), /未注册/);
});

test('容器：has 判断未注册服务', () => {
  const container = new Container();
  assert.strictEqual(container.has('missing'), false);
});
