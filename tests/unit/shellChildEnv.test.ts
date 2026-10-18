import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ShellChildEnv } from '../../src/adapters/tool/shell/shellChildEnv.ts';

/**
 * 在受控 NODE_OPTIONS 下执行并恢复进程环境（用例不得污染其它判据）。
 * @param value 临时 NODE_OPTIONS 值（undefined 表示删除）
 * @param fn 断言体
 */
function withNodeOptions(value: string | undefined, fn: () => void): void {
  const had = Object.hasOwn(process.env, 'NODE_OPTIONS');
  const saved = process.env['NODE_OPTIONS'];
  try {
    if (value === undefined) delete process.env['NODE_OPTIONS'];
    else process.env['NODE_OPTIONS'] = value;
    fn();
  } finally {
    if (had) process.env['NODE_OPTIONS'] = saved;
    else delete process.env['NODE_OPTIONS'];
  }
}

test('剔除代理 shim，保留其它 NODE_OPTIONS 参数', () => {
  withNodeOptions(
    '--max-old-space-size=2048 --require node-language-shim.cjs --enable-source-maps',
    () => {
      const env = ShellChildEnv.clean();
      assert.strictEqual(env['NODE_OPTIONS'], '--max-old-space-size=2048 --enable-source-maps');
    },
  );
});

test('safe-delete / brokered-fs 同样剔除（不区分大小写）', () => {
  withNodeOptions('--require NODE-SAFE-DELETE --require node-brokered-fs', () => {
    assert.strictEqual(ShellChildEnv.clean()['NODE_OPTIONS'], '');
  });
});

test('无 NODE_OPTIONS 时给空串，不把 undefined 写进环境', () => {
  withNodeOptions(undefined, () => {
    assert.strictEqual(ShellChildEnv.clean()['NODE_OPTIONS'], '');
  });
});

test('不修改调用方进程环境', () => {
  withNodeOptions('--require node-language-shim.cjs', () => {
    ShellChildEnv.clean();
    assert.strictEqual(process.env['NODE_OPTIONS'], '--require node-language-shim.cjs');
  });
});
