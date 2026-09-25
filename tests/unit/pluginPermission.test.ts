import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../../src/core/container.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import { PermissionGate, PermissionDeniedError } from '../../src/plugin/permissionGate.js';
import { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, Permission } from '../../src/plugin/permission.js';
import type { Plugin } from '../../src/plugin/plugin.js';
import type { PluginPermission } from '../../src/plugin/permission.js';

/** 构造声明指定权限的插件。 */
function pluginWith(name: string, permissions?: readonly PluginPermission[]): Plugin {
  return {
    meta: { name, permissions },
    apply(): void {
      // 无副作用
    },
  };
}

test('PermissionGate：denyAll 拒绝一切，allowAll 放行一切', () => {
  const deny = PermissionGate.denyAll();
  assert.deepStrictEqual(deny.check(['fs.read']), { allowed: false, missing: ['fs.read'] });
  const allow = PermissionGate.allowAll();
  assert.strictEqual(allow.check(ALL_PERMISSIONS).allowed, true);
  assert.deepStrictEqual(allow.check(ALL_PERMISSIONS).missing, []);
});

test('PermissionGate：fromList 子集放行，超集拒绝并列出缺失', () => {
  const gate = PermissionGate.fromList(['fs.read', 'env.read']);
  assert.deepStrictEqual(gate.check(['fs.read']), { allowed: true, missing: [] });
  const denied = gate.check(['fs.read', 'proc.exec']);
  assert.strictEqual(denied.allowed, false);
  assert.deepStrictEqual(denied.missing, ['proc.exec']);
  // 未声明权限视为允许（无能力声明）
  assert.deepStrictEqual(gate.check(undefined), { allowed: true, missing: [] });
});

test('PermissionGate：assertAllowed 超限抛 PermissionDeniedError', () => {
  const gate = PermissionGate.fromList(['fs.read']);
  assert.throws(
    () => gate.assertAllowed('p', ['fs.write']),
    (error: unknown) =>
      error instanceof PermissionDeniedError &&
      error.pluginName === 'p' &&
      error.message.includes('fs.write'),
  );
});

test('危险权限集覆盖写/删除/执行/监听等高危能力', () => {
  for (const dangerous of [
    'fs.write',
    'fs.delete',
    'proc.exec',
    'net.listen',
    'env.write',
    'store.write',
  ]) {
    assert.strictEqual(
      DANGEROUS_PERMISSIONS.has(dangerous as PluginPermission),
      true,
      `应含 ${dangerous}`,
    );
  }
  // 只读权限不应在危险集内
  assert.strictEqual(DANGEROUS_PERMISSIONS.has('fs.read'), false);
  assert.strictEqual(DANGEROUS_PERMISSIONS.has('env.read'), false);
});

test('isPluginPermission：校验合法与非法权限名', () => {
  assert.strictEqual(Permission.isPluginPermission('fs.read'), true);
  assert.strictEqual(Permission.isPluginPermission('proc.exec'), true);
  assert.strictEqual(Permission.isPluginPermission('fs.*'), false);
  assert.strictEqual(Permission.isPluginPermission('unknown'), false);
  assert.strictEqual(Permission.isPluginPermission(''), false);
});

test('PluginManager：无权限声明的插件可正常注册启动', async () => {
  const manager = new PluginManager(new Container(), PermissionGate.denyAll());
  await manager.register(pluginWith('safe'));
  assert.strictEqual(manager.isStarted('safe'), true);
});

test('PluginManager：声明权限在白名单内则启动', async () => {
  const manager = new PluginManager(new Container(), PermissionGate.fromList(['fs.read']));
  await manager.register(pluginWith('reader', ['fs.read']));
  assert.strictEqual(manager.isStarted('reader'), true);
});

test('PluginManager：声明权限超白名单则拒绝注册（fail-closed，不残留）', async () => {
  const manager = new PluginManager(new Container(), PermissionGate.fromList(['fs.read']));
  await assert.rejects(
    () => manager.register(pluginWith('rogue', ['fs.write'])),
    (error: unknown) => error instanceof PermissionDeniedError && error.pluginName === 'rogue',
  );
  // 被拒插件不应进入已注册列表（未启动、无残留）
  assert.strictEqual(manager.isStarted('rogue'), false);
  assert.deepStrictEqual(manager.names(), []);
});

test('PluginManager：声明两个权限、仅放行其一 → 拒绝', async () => {
  const manager = new PluginManager(new Container(), PermissionGate.fromList(['env.read']));
  await assert.rejects(
    () => manager.register(pluginWith('p2', ['env.read', 'env.write'])),
    PermissionDeniedError,
  );
  assert.strictEqual(manager.isStarted('p2'), false);
});

test('PluginManager：未配置门禁（gate 缺省）时不限制权限', async () => {
  const manager = new PluginManager(new Container());
  await manager.register(pluginWith('free', ['proc.exec']));
  assert.strictEqual(manager.isStarted('free'), true);
});
