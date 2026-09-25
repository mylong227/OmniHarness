import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/config/configError.js';

describe('permission 段：严格校验（fail-closed）', () => {
  it('合法规则通过（含 commandGlob）', () => {
    assert.doesNotThrow(() =>
      ConfigError.normalizeConfig({
        permission: {
          rules: [{ toolName: 'shell', commandGlob: '*rm -rf*', decision: 'deny' }],
          defaultDecision: 'allow',
        },
      }),
    );
  });

  it('permission 非对象抛错', () => {
    assert.throws(() => ConfigError.normalizeConfig({ permission: [] }), ConfigError);
    assert.throws(() => ConfigError.normalizeConfig({ permission: 'x' }), ConfigError);
  });

  it('permission 含未知子 key 抛错', () => {
    assert.throws(() => ConfigError.normalizeConfig({ permission: { nope: 1 } }), ConfigError);
  });

  it('规则含未知 key 抛错', () => {
    assert.throws(
      () =>
        ConfigError.normalizeConfig({ permission: { rules: [{ decision: 'deny', bogus: 1 }] } }),
      ConfigError,
    );
  });

  it('decision 非法抛错（规则级与默认级）', () => {
    assert.throws(
      () => ConfigError.normalizeConfig({ permission: { rules: [{ decision: 'maybe' }] } }),
      ConfigError,
    );
    assert.throws(
      () => ConfigError.normalizeConfig({ permission: { defaultDecision: 'maybe' } }),
      ConfigError,
    );
  });

  it('rules 非数组 / 规则非对象抛错', () => {
    assert.throws(() => ConfigError.normalizeConfig({ permission: { rules: 'x' } }), ConfigError);
    assert.throws(() => ConfigError.normalizeConfig({ permission: { rules: [1] } }), ConfigError);
  });

  it('规则字段类型错误抛错（空串 / 非字符串）', () => {
    assert.throws(
      () =>
        ConfigError.normalizeConfig({
          permission: { rules: [{ decision: 'deny', commandGlob: '' }] },
        }),
      ConfigError,
    );
    assert.throws(
      () =>
        ConfigError.normalizeConfig({ permission: { rules: [{ decision: 'deny', toolName: 3 }] } }),
      ConfigError,
    );
  });
});
