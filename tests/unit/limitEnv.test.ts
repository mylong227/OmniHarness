/**
 * LimitEnv 校验分支（对应「把并发/体积上限做成可配置项」）：
 * 未配置 / 空 / 非整数 / 低于下限 → 安全回退 fallback；合法整数 → 生效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LimitEnv } from '../../src/util/limitEnv.js';

const KEY = 'OMNI_TEST_LIMIT_UNIT';

test('LimitEnv.int：未配置时回退 fallback', () => {
  delete process.env[KEY];
  assert.strictEqual(LimitEnv.int(KEY, 42), 42);
});

test('LimitEnv.int：空字符串回退 fallback', () => {
  process.env[KEY] = '   ';
  try {
    assert.strictEqual(LimitEnv.int(KEY, 7), 7);
  } finally {
    delete process.env[KEY];
  }
});

test('LimitEnv.int：非数字回退 fallback', () => {
  process.env[KEY] = 'abc';
  try {
    assert.strictEqual(LimitEnv.int(KEY, 7), 7);
  } finally {
    delete process.env[KEY];
  }
});

test('LimitEnv.int：小数回退 fallback（仅整数合法）', () => {
  process.env[KEY] = '3.5';
  try {
    assert.strictEqual(LimitEnv.int(KEY, 7), 7);
  } finally {
    delete process.env[KEY];
  }
});

test('LimitEnv.int：低于 min 回退 fallback', () => {
  process.env[KEY] = '0';
  try {
    assert.strictEqual(LimitEnv.int(KEY, 7, 1), 7);
  } finally {
    delete process.env[KEY];
  }
});

test('LimitEnv.int：合法整数生效（遵守 min 下限）', () => {
  process.env[KEY] = '16';
  try {
    assert.strictEqual(LimitEnv.int(KEY, 7, 1), 16);
    assert.strictEqual(LimitEnv.int(KEY, 7, 10), 16);
  } finally {
    delete process.env[KEY];
  }
});
