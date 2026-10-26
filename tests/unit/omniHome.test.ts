/**
 * OmniHome 判据：归属根解析的唯一事实源。
 *
 * 钉三条口径（见 src/util/omniHome.ts 注释）：
 * ① 显式注入 > OMNI_HOME 环境变量 > ~/.omniharness（注入压过环境——判据封闭性不受真机 setx 影响）；
 * ② OMNI_HOME 是「整体搬盘」的唯一旋钮：sessions/tmp 全部跟随；
 * ③ OMNI_TMP_DIR 可单独指定临时根。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { OmniHome } from '../../src/util/omniHome.ts';

test('OmniHome：无注入无环境时回落 ~/.omniharness（历史行为逐字节一致）', () => {
  assert.strictEqual(OmniHome.dir(undefined, {}), join(homedir(), '.omniharness'));
});

test('OmniHome：显式注入压过 OMNI_HOME（判据封闭性）', () => {
  const env = { OMNI_HOME: 'D:\\omniharness-home' };
  assert.strictEqual(
    OmniHome.dir('C:\\tmp\\fake-home', env),
    join('C:\\tmp\\fake-home', '.omniharness'),
  );
  // 不注入时环境变量生效（相对路径解析为绝对）。
  assert.strictEqual(OmniHome.dir(undefined, env), resolve('D:\\omniharness-home'));
  // 空白值视同未设置。
  assert.strictEqual(
    OmniHome.dir(undefined, { OMNI_HOME: '   ' }),
    join(homedir(), '.omniharness'),
  );
});

test('OmniHome：sessions/tmp 全部跟随归属根；OMNI_TMP_DIR 可单独覆盖', () => {
  const env = { OMNI_HOME: 'D:\\oh-home' };
  assert.strictEqual(OmniHome.sessionsDir(undefined, env), join('D:\\oh-home', 'sessions'));
  assert.strictEqual(OmniHome.tmpRoot(undefined, env), join('D:\\oh-home', 'tmp'));
  assert.strictEqual(
    OmniHome.tmpRoot(undefined, { OMNI_TMP_DIR: 'E:\\oh-tmp' }),
    resolve('E:\\oh-tmp'),
  );
  // 注入 home 时同样跟随（且不受 OMNI_HOME 干扰）。
  assert.strictEqual(
    OmniHome.sessionsDir('C:\\tmp\\h', env),
    join('C:\\tmp\\h', '.omniharness', 'sessions'),
  );
});
