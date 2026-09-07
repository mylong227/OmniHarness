import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OmniError, ErrorCode } from '../../src/errors.js';
import { ConfigError } from '../../src/config/configLayer.js';
import { ModelCallError } from '../../src/ports/model.js';
import { EgressBlockedError } from '../../src/adapters/sandbox/networkEgress.js';

test('OmniError：携带稳定错误码', () => {
  const err = new OmniError(ErrorCode.UNKNOWN, 'boom');
  assert.strictEqual(err.code, 'UNKNOWN');
  assert.strictEqual(err.name, 'OmniError');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OmniError);
});

test('错误子类：迁移后 code 与类名正确', () => {
  assert.strictEqual(new ConfigError('bad').code, ErrorCode.CONFIG_ERROR);
  assert.strictEqual(new ConfigError('bad').name, 'ConfigError');

  const modelErr = new ModelCallError('5xx', { status: 500, retryable: true });
  assert.strictEqual(modelErr.code, ErrorCode.MODEL_CALL_ERROR);
  assert.strictEqual(modelErr.retryable, true);

  const egress = new EgressBlockedError('blocked', 'http://x/');
  assert.strictEqual(egress.code, ErrorCode.EGRESS_BLOCKED);
  assert.strictEqual(egress.url, 'http://x/');
});
