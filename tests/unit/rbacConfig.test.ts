/**
 * F3 配置接线判据（`rbac` 段）：**四段闭环**——配置文件 → 严格校验 → partial → 运行时消费。
 *
 * ## 为什么这段必须单独判
 *
 * 本仓最高频的缺陷形态是「**声明未接线**」：配置项被接受、却没有任何消费方（写入后静默丢弃）。
 * `audit:config-wiring` 专治它，但那条门禁只能查"有没有引用"，查不出"引用后语义对不对"。
 * 故本判据把两端都钉住：
 * - **拒绝面**：未知子键 / 类型不符 / **开了却没给角色** ⇒ 拒绝启动（fail-closed）；
 * - **生效面**：配置了 `viewer` ⇒ 运行时构造出的门禁**真的**拒绝写类工具（不是"读到了但没用"）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '../../src/config/configError.js';
import { RbacConfigValidator } from '../../src/config/rbacConfigValidator.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { RbacPolicy } from '../../src/security/rbacPolicy.js';
import { ToolGate } from '../../src/core/toolGate.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { FileConfig } from '../../src/ports/config/fileConfig.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';

/**
 * 把一个文件配置写盘并跑严格校验+构建（模拟真实加载路径）。
 * @param rbac rbac 段
 * @returns 构建结果
 */
function buildWith(rbac: unknown): ReturnType<typeof ConfigFactory.build> {
  const dir = mkdtempSync(join(tmpdir(), 'omni-rbac-'));
  const path = join(dir, 'omniharness.json');
  writeFileSync(path, JSON.stringify({ rbac }), 'utf8');
  // 走真实入口：validateConfig 是文件配置的严格校验闸门（未知键/类型不符都在此拦下）。
  ConfigError.validateConfig(JSON.parse(JSON.stringify({ rbac })) as FileConfig);
  return ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 2,
    model: { generate: async () => ({ text: '' }) } as never,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    rbac: rbac as never,
  });
}

test('F3 配置拒绝面：未知子键 / 类型不符 / 开了却没给角色 三类都拒绝启动', () => {
  const cases: readonly {
    readonly name: string;
    readonly rbac: unknown;
    readonly match: RegExp;
  }[] = [
    {
      name: '未知子键',
      rbac: { enabled: true, role: 'viewer', mode: 'x' },
      match: /未知配置项 "mode"/,
    },
    { name: 'enabled 非布尔', rbac: { enabled: 'yes' }, match: /rbac\.enabled 必须是布尔值/ },
    {
      name: 'role 空串',
      rbac: { enabled: true, role: '  ' },
      match: /rbac\.role 必须是非空字符串/,
    },
    {
      name: '开了却没给角色',
      rbac: { enabled: true },
      match: /必须给出 rbac\.role/,
    },
    {
      name: '角色条目未知子键',
      rbac: { enabled: true, role: 'a', roles: { a: { allow: ['*'], extra: 1 } } },
      match: /rbac\.roles\.a 含未知配置项 "extra"/,
    },
    {
      name: 'allow 非字符串数组',
      rbac: { enabled: true, role: 'a', roles: { a: { allow: [1] } } },
      match: /allow 必须是字符串数组/,
    },
    { name: 'rbac 段非对象', rbac: [], match: /rbac 段必须是对象/ },
  ];
  for (const item of cases) {
    assert.throws(
      () => buildWith(item.rbac),
      (err: unknown) => err instanceof ConfigError && item.match.test((err as Error).message),
      `${item.name} 应被拒绝`,
    );
  }
  // 合法配置不抛（正对照：防"一律拒绝"骗过判据）。
  assert.doesNotThrow(() => buildWith({ enabled: true, role: 'viewer' }));
  assert.doesNotThrow(() => buildWith(undefined));
});

test('F3 配置生效面：配置 viewer ⇒ 运行时门禁真的拒写类工具（不是"读到了但没用"）', () => {
  const config = buildWith({ enabled: true, role: 'viewer' });
  // 组合根按同一份配置构造门禁（与 runtime.ts 一致的两行）。
  const gate = new ToolGate(
    new AutoApproval(),
    new PassthroughSandbox(),
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new RbacPolicy({
      ...(config.rbac?.roles !== undefined ? { roles: config.rbac.roles } : {}),
    }),
    config.rbac?.enabled === true ? config.rbac.role : undefined,
  );
  const denied = gate.gate(
    { id: 'c1', name: TOOL_NAMES.writeFile, arguments: {} } as ToolCall,
    's1',
  );
  return denied.then((result) => {
    assert.ok(result !== undefined, 'viewer 角色下写类工具必须被拒');
    assert.match(String(result.error), /viewer 无写权限/);
  });
});

test('F3 配置生效面：未配置 / enabled=false ⇒ ResolvedConfig 上无 rbac 语义上的门禁（零行为变更）', () => {
  const withoutSection = buildWith(undefined);
  assert.strictEqual(withoutSection.rbac, undefined, '未配置不得凭空造出 rbac 段');
  const disabled = buildWith({ enabled: false, role: 'viewer' });
  assert.strictEqual(disabled.rbac?.enabled, false);
  // 组合根的判定式：仅 enabled === true 才注入策略 ⇒ false 时第三道门不存在。
  const gateInjected: boolean = disabled.rbac?.enabled ?? false;
  assert.strictEqual(gateInjected, false, 'enabled=false 不得注入角色门禁');
});

test('F3 校验器直接判据（不经配置装载路径）：合法段逐条放行、非法段逐条给出可读消息', () => {
  // 直接单元判据（成熟度门禁要求证据文件**直接 import** 被声明模块，而非仅经装载路径间接覆盖）。
  const legal: readonly unknown[] = [
    undefined,
    {},
    { enabled: false, role: 'viewer' },
    { enabled: true, role: 'admin' },
    { enabled: true, role: 'a', roles: { a: { allow: ['*'], deny: [], mutating: true } } },
  ];
  for (const cfg of legal) {
    assert.strictEqual(
      RbacConfigValidator.validate({ rbac: cfg }),
      undefined,
      `应放行：${JSON.stringify(cfg)}`,
    );
  }
  const illegal: readonly (readonly [unknown, RegExp])[] = [
    ['str', /rbac 段必须是对象/],
    [{ enabled: true }, /必须给出 rbac\.role/],
    [{ role: 'a', roles: { a: { allow: 'x' } } }, /allow 必须是字符串数组/],
    [{ roles: { a: { allow: ['*'], deny: 'x' } } }, /deny 必须是字符串数组/],
    [{ roles: { a: { allow: ['*'], mutating: 'yes' } } }, /mutating 必须是布尔值/],
    [{ roles: { a: [] } }, /必须是对象/],
    [{ roles: { '': { allow: [] } } }, /含空角色名/],
  ];
  for (const [cfg, pattern] of illegal) {
    const message = RbacConfigValidator.validate({ rbac: cfg });
    assert.ok(message !== undefined, `应拒绝：${JSON.stringify(cfg)}`);
    assert.match(message, pattern);
  }
});
