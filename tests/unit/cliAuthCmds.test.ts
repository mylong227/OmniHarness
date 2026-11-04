/**
 * 企业 SSO auth 命令族判据（2026-11-04 覆盖率补测，原 26.72%）。
 *
 * 钉死的是**安全契约的错误路径**（2026-10-27 审计收口的回归防线）：
 * `auth callback` 的 `--state` 必带（缺省即拒，防 CSRF）、中间态缺失/超 TTL/不匹配各给
 * 可行动提示而非堆栈、用法错误退出码 2。
 *
 * 诚实边界：login/callback 的**成功路径**需要可达的真实 IdP（`OpenIdClientFlow` 硬实例化、
 * 不可注入），本机仅测错误路径——与源码 D2 说明同口径。
 */
import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliAuthCmds } from '../../src/apps/cli/cliAuthCmds.ts';
import { OidcClient } from '../../src/apps/enterprise/oidcClient.ts';
import { OmniHome } from '../../src/kernel/util/omniHome.ts';

/** 静音双流并捕获输出。 */
function silence<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  });
  return run()
    .finally(() => {
      write.mockRestore();
      err.mockRestore();
    })
    .then((value) => ({ value, out }));
}

/** 旗标读取器（与宿主链基 flagValue 同语义：`--flag value` / `--flag=value`）。 */
const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const prefix = `${flag}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const cmds = new CliAuthCmds({ flagValue });
const HOME = mkdtempSync(join(tmpdir(), 'omni-auth-'));
const statePath = (): string => join(OmniHome.dir(), 'auth-state.json');

beforeAll(() => {
  process.env['OMNI_HOME'] = HOME;
});

afterAll(() => {
  delete process.env['OMNI_HOME'];
});

test('① 用法：未知子动作 / 空 args ⇒ 2 并打印用法', async () => {
  const { value, out } = await silence(() => cmds.run(['bogus']));
  assert.strictEqual(value, 2);
  assert.match(out, /用法: omniharness auth/u);
  assert.strictEqual((await silence(() => cmds.run([]))).value, 2);
});

test('② login：缺 --issuer / --client-id ⇒ 2（不发网络请求）', async () => {
  const missingAll = await silence(() => cmds.run(['login']));
  assert.strictEqual(missingAll.value, 2);
  assert.match(missingAll.out, /--issuer 与 --client-id/u);
  const missingClient = await silence(() => cmds.run(['login', '--issuer', 'https://idp.example']));
  assert.strictEqual(missingClient.value, 2);
});

test('③ callback：--code 与 --state 各自必带（state 缺省即拒——防 CSRF 收口的回归防线）', async () => {
  const noCode = await silence(() => cmds.run(['callback']));
  assert.strictEqual(noCode.value, 2);
  assert.match(noCode.out, /--code/u);
  const noState = await silence(() => cmds.run(['callback', '--code', 'abc']));
  assert.strictEqual(noState.value, 2);
  assert.match(noState.out, /--state.*防 CSRF/u);
});

test('④ callback：中间态文件缺失 ⇒ 1 并提示先 login', async () => {
  if (existsSync(statePath())) {
    OidcClient.writeAuthState(statePath(), {
      issuer: 'https://idp.example',
      clientId: 'c',
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      createdAt: new Date().toISOString(),
    });
  }
  const path = statePath();
  if (existsSync(path)) {
    OidcClient.writeAuthState(path, {
      issuer: 'x',
      clientId: 'c',
      state: 'keepalive',
      nonce: 'n',
      codeVerifier: 'v',
      createdAt: new Date().toISOString(),
    });
  }
  // 删除后测缺失分支（writeAuthState 的存在只为保护别的测试可能留下的现场）。
  const { rmSync } = await import('node:fs');
  rmSync(path, { force: true });
  const result = await silence(() => cmds.run(['callback', '--code', 'c', '--state', 's']));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /未找到中间态文件/u);
});

test('⑤ callback：中间态超 TTL（>10 分钟）⇒ 1 且给可行动提示（不抛堆栈）', async () => {
  const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  OidcClient.writeAuthState(statePath(), {
    issuer: 'https://idp.example',
    clientId: 'c',
    state: 'good',
    nonce: 'n',
    codeVerifier: 'v',
    createdAt: stale,
  });
  const result = await silence(() => cmds.run(['callback', '--code', 'c', '--state', 'good']));
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /(过期|TTL|重新)/u);
});

test('⑥ callback：state 不匹配 ⇒ 1（CSRF 防线的第二道闸）', async () => {
  OidcClient.writeAuthState(statePath(), {
    issuer: 'https://idp.example',
    clientId: 'c',
    state: 'real-state',
    nonce: 'n',
    codeVerifier: 'v',
    createdAt: new Date().toISOString(),
  });
  const result = await silence(() =>
    cmds.run(['callback', '--code', 'c', '--state', 'evil-state']),
  );
  assert.strictEqual(result.value, 1);
  assert.match(result.out, /state 不匹配/u);
});
