/**
 * 凭据保险库 RPC 判据（Web 交付第 6 个入口，2026-10-11）。
 *
 * ## 这是一条**写凭据**的通路，判据比只读面板严
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 未接线 ⇒ 三条 RPC 都回 `{ok:false, reason}` | 面板把"没接线"读成"保险库是空的"（用户以为凭据丢了） |
 * | ② | **只回名字、不回值**：`vault.list` 的响应序列化后不得含密文 | 密文经 HTTP 进浏览器/日志/前端状态＝多一条泄露面 |
 * | ③ | **故意不提供读值方法**：注册表里除 `vault.list/set/delete` 外没有别的 `vault.*` | 有人后来补一个 `vault.get` 就把纪律②绕过去了 |
 * | ④ | `set` → `list` 往返可见；`delete` 后消失 | 入口空转 |
 * | ⑤ | 空名字 / 空 secret **fail-closed** 拒绝 | 空名字写出按名取不到的孤儿条目；空值静默覆盖有效凭据 |
 * | ⑥ | **两条组合根都要接线**：stdio 与 serve 都必须注入 `doctorReport`（serve 是 Web UI 实际连的那条） | 真机上诊断面板恒回"未接线"，而本地 stdio 跑测一切正常 |
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppServer } from '../../src/server/core/appServer.ts';
import { AppServerVaultHandlers } from '../../src/server/core/appServerVaultHandlers.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { VaultPort } from '../../src/ports/memory/vault.ts';

/** 仓库根（判据在 `dist/tests/unit/`，源码按 cwd 读）。 */
const REPO_ROOT = process.cwd();

/** 内存凭据保险库替身（真存密文，供泄漏检测用）。 */
class MemoryVault implements VaultPort {
  /** 端口名（判据里仅用于自证实现身份）。 */
  public readonly name = 'memory-vault-judge';
  /** 内存密文表（判据用它做泄漏检测的对照源）。 */
  private readonly store = new Map<string, string>();

  /**
   * 读取凭据（判据只在服务端内部路径上使用；RPC 面无此能力）。
   * @param name 凭据名
   * @returns 密文或 undefined
   */
  public getSecret(name: string): Promise<string | undefined> {
    return Promise.resolve(this.store.get(name));
  }

  /**
   * 写入凭据。
   * @param name 凭据名
   * @param value 密文
   * @returns 无返回值
   */
  public setSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
    return Promise.resolve();
  }

  /**
   * 删除凭据。
   * @param name 凭据名
   * @returns 存在且删除成功为 true
   */
  public deleteSecret(name: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(name));
  }

  /**
   * 凭据是否存在。
   * @param name 凭据名
   * @returns 存在为 true
   */
  public hasSecret(name: string): Promise<boolean> {
    return Promise.resolve(this.store.has(name));
  }

  /**
   * 列出全部凭据名（**不含值**）。
   * @returns 凭据名列表
   */
  public listSecrets(): Promise<readonly string[]> {
    return Promise.resolve([...this.store.keys()]);
  }

  /**
   * 关闭底层资源。
   * @returns 无返回值
   */
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 造一个服务端。
 * @param vault 可选的保险库（不传＝未接线）。
 * @returns 服务端实例
 */
function makeServer(vault?: VaultPort): AppServer {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: { generate: async () => ({ text: '' }) } as never,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new AppServer({
    config,
    transport: { send: () => {}, onMessage: () => {} },
    modelOverrideEnabled: false,
    ...(vault === undefined ? {} : { vault }),
  });
}

/** 取处理器表。 */
function handlersOf(
  server: AppServer,
): Map<string, (p: Record<string, unknown>) => Promise<unknown>> {
  return (
    server as unknown as {
      handlers: Map<string, (p: Record<string, unknown>) => Promise<unknown>>;
    }
  ).handlers;
}

/**
 * 调一个 RPC。
 * @param server 服务端
 * @param method 方法名
 * @param params 参数
 * @returns 返回体
 */
async function call(
  server: AppServer,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = handlersOf(server).get(method);
  assert.ok(handler !== undefined, `必须注册 ${method}`);
  return handler(params);
}

test('① 未接线 ⇒ 三条 RPC 都如实报错（不装作"保险库是空的"）', async () => {
  for (const method of ['vault.list', 'vault.set', 'vault.delete']) {
    const result = (await call(makeServer(), method, { name: 'x', secret: 'y' })) as {
      ok: boolean;
      reason?: string;
    };
    assert.strictEqual(result.ok, false, `${method} 未接线必须 ok:false`);
    assert.match(String(result.reason), /未接线/u, `${method} 必须给出可读原因`);
    assert.strictEqual('names' in result, false, `${method} 不得回 names（空数组同样是伪装）`);
  }
});

test('② 只回名字、不回值：响应序列化后不得含密文', async () => {
  const vault = new MemoryVault();
  const secret = 'sk-super-secret-value-123';
  const server = makeServer(vault);
  await call(server, 'vault.set', { name: 'openai', secret });
  const listed = await call(server, 'vault.list');
  const json = JSON.stringify(listed);
  assert.ok(!json.includes(secret), `vault.list 的响应泄露了密文：${json}`);
  assert.deepStrictEqual((listed as { names: string[] }).names, ['openai'], '必须回名字');
});

test('③ 故意不提供读值方法：除 list/set/delete 外没有别的 vault.*', () => {
  const keys = [...handlersOf(makeServer()).keys()].filter((k) => k.startsWith('vault.'));
  assert.deepStrictEqual(
    [...keys].sort(),
    ['vault.delete', 'vault.list', 'vault.set'],
    '多出一个 vault.* 方法即可能把"不回读"的纪律绕过去（尤其 vault.get）',
  );
  assert.strictEqual(keys.includes('vault.get'), false, '不得提供 vault.get（凭据不回读给浏览器）');
});

test('④ set → list 往返可见；delete 后消失', async () => {
  const vault = new MemoryVault();
  const server = makeServer(vault);
  const set = (await call(server, 'vault.set', { name: 'kimi', secret: 'sk-k' })) as {
    ok: boolean;
  };
  assert.strictEqual(set.ok, true);
  assert.deepStrictEqual((await call(server, 'vault.list')) as { names: string[] }, {
    ok: true,
    names: ['kimi'],
  });
  const del = (await call(server, 'vault.delete', { name: 'kimi' })) as {
    ok: boolean;
    removed: boolean;
  };
  assert.strictEqual(del.ok, true);
  assert.strictEqual(del.removed, true, '删掉存在的条目必须 removed:true');
  assert.deepStrictEqual((await call(server, 'vault.list')) as { names: string[] }, {
    ok: true,
    names: [],
  });
  const again = (await call(server, 'vault.delete', { name: 'kimi' })) as { removed: boolean };
  assert.strictEqual(again.removed, false, '删不存在的条目应 removed:false（而不是报成功）');
});

test('⑤ 空名字 / 空 secret fail-closed', async () => {
  const server = makeServer(new MemoryVault());
  for (const [params, expect] of [
    [{ name: '  ', secret: 'x' }, /非空 name/u],
    [{ name: 'a', secret: '' }, /非空 secret/u],
    [{ secret: 'x' }, /非空 name/u],
  ] as const) {
    const result = (await call(server, 'vault.set', params)) as { ok: boolean; reason?: string };
    assert.strictEqual(result.ok, false, `应拒绝：${JSON.stringify(params)}`);
    assert.match(String(result.reason), expect);
  }
  const del = (await call(server, 'vault.delete', { name: '' })) as { ok: boolean };
  assert.strictEqual(del.ok, false, 'delete 空名字也必须拒绝');
});

test('⑥ 两条组合根都要接线：stdio 与 serve 都注入 doctorReport（附正对照）', () => {
  assert.ok(
    AppServer.prototype instanceof AppServerVaultHandlers,
    'AppServer 必须经由 AppServerVaultHandlers 层（否则该层是死代码）',
  );
  const source = readFileSync(join(REPO_ROOT, 'src/cli/cliServerCmds.ts'), 'utf8');
  const injections = [
    ...source.matchAll(/doctorReport:\s*\(options\)\s*=>\s*DoctorRunner\.runDoctor\(/gu),
  ];
  assert.strictEqual(
    injections.length,
    2,
    `stdio 与 serve **两条**组合根都必须注入 doctorReport（实际 ${String(injections.length)} 处）；` +
      'serve 是 Web UI 实际连的那条，漏了会让面板在真机上恒回"未接线"',
  );
  // serve 那条还必须注入 vault（否则第 6 个入口在真机上恒为未接线）。
  assert.match(source, /vault:\s*await this\.buildServeVault\(args\)/u, 'serve 必须注入保险库');

  // **正对照**：删掉一处注入必须被检出。
  const mutated = source.replace(
    /doctorReport:\s*\(options\)\s*=>\s*DoctorRunner\.runDoctor\(/u,
    'x',
  );
  const mutatedCount = [
    ...mutated.matchAll(/doctorReport:\s*\(options\)\s*=>\s*DoctorRunner\.runDoctor\(/gu),
  ].length;
  assert.strictEqual(mutatedCount, 1, '正对照：删一处后应只剩 1 处（否则判据恒真）');
});
