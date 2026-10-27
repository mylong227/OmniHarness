/**
 * auth callback 的 CSRF/TTL 防线判据（2026-10-27 审计收口）。
 *
 * 缺陷现场：`--state` 缺省时整段 CSRF 校验被跳过——攻击者诱导受害者执行
 * `auth callback --code <攻击者code>`（不带 --state）即可注入授权码。现在缺省即拒。
 * 中间态 TTL 由 `OidcClient.readAuthState` 内置（10 分钟），回调侧负责把它的抛错
 * 转成可行动提示（此前抛错无人接住）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliAuthCmds } from '../../src/cli/cliAuthCmds.ts';

/** 直跑入口（run 的 login/callback 分发在此之下，判据直接打 callback 参数）。 */
function makeCmds(): CliAuthCmds {
  return new CliAuthCmds({
    flagValue: (args, flag) => {
      const i = args.indexOf(flag);
      return i >= 0 ? args[i + 1] : undefined;
    },
  });
}

/** 把 homedir 重定向到临时目录（回调读 `<home>/.omni-auth-state.json`）。 */
function withHome(dir: string): { restore: () => void } {
  const savedHome = process.env['HOME'];
  const savedProfile = process.env['USERPROFILE'];
  process.env['HOME'] = dir;
  process.env['USERPROFILE'] = dir;
  return {
    restore: (): void => {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = savedProfile;
    },
  };
}

test('auth callback：缺 --state 直接拒绝（fail-closed，不再跳过 CSRF 校验）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-auth-cb-'));
  const home = withHome(dir);
  try {
    writeFileSync(
      join(dir, '.omni-auth-state.json'),
      JSON.stringify({
        issuer: 'https://idp',
        clientId: 'cli',
        clientSecret: 'secret',
        state: 'st-123',
        codeVerifier: 'verifier',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const exit = await makeCmds().run(['callback', '--code', 'abc']);
    assert.strictEqual(exit, 2, '缺 --state 必须以用法错误退出，而不是跳过校验');
  } finally {
    home.restore();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('auth callback：--state 不匹配拒绝；过期中间态给出可行动提示而非堆栈', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-auth-cb2-'));
  const home = withHome(dir);
  try {
    writeFileSync(
      join(dir, '.omni-auth-state.json'),
      JSON.stringify({
        issuer: 'https://idp',
        clientId: 'cli',
        clientSecret: 'secret',
        state: 'st-123',
        codeVerifier: 'verifier',
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const mismatch = await makeCmds().run(['callback', '--code', 'abc', '--state', 'wrong']);
    assert.strictEqual(mismatch, 1, 'state 不匹配必须拒绝');
  } finally {
    home.restore();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  // 过期态：readAuthState 抛"已过期"，回调侧必须转成 exit 1（此前是无人接住的异常）。
  const dir2 = mkdtempSync(join(tmpdir(), 'omni-auth-cb3-'));
  const home2 = withHome(dir2);
  try {
    writeFileSync(
      join(dir2, '.omni-auth-state.json'),
      JSON.stringify({
        issuer: 'https://idp',
        clientId: 'cli',
        clientSecret: 'secret',
        state: 'st-123',
        codeVerifier: 'verifier',
        createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      }),
      'utf8',
    );
    const exit = await makeCmds().run(['callback', '--code', 'abc', '--state', 'st-123']);
    assert.strictEqual(exit, 1, '过期中间态必须拒绝');
  } finally {
    home2.restore();
    rmSync(dir2, { recursive: true, force: true, maxRetries: 3 });
  }
});
