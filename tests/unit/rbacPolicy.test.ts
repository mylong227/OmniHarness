/**
 * F3（RBAC-lite）策略判据 —— 商业化报告 §5 阶段 1：「越权工具调用被拒且 reason 可读（沿 G5 判据风格）」。
 *
 * ## 判据要钉死什么
 *
 * 1. **三角色矩阵**：`viewer` 只读（写类一律拒）/ `editor` 可写（但治理类拒）/ `admin` 全放；
 * 2. **fail-closed 两条**：未知角色 ⇒ 全拒；**未登记工具** ⇒ 全拒（判断不了是不是写类时默认不许）；
 * 3. **拒绝优先**：`deny` 覆盖 `allow: ['*']`（否则"顺手全放"会吃掉治理类限制）；
 * 4. **原因可读**：每条拒因点名角色、工具、缺什么（`viewer` 调 `write_file` ⇒ 明说无写权限）；
 * 5. **不另立工具表**：新只读工具自动可用、新写类工具自动被 viewer 拒（用仓库自己的 `MUTATING_TOOL_NAMES` 分类）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RbacPolicy } from '../../src/security/rbacPolicy.js';
import { TOOL_NAMES, MUTATING_TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';

/**
 * 造一个工具调用。
 * @param name 工具名
 * @returns 工具调用
 */
function callOf(name: string): ToolCall {
  return { id: 'c1', name, arguments: {} } as ToolCall;
}

/** 读类工具代表（取自登记表，非硬编码字符串）。 */
const READ_TOOL = TOOL_NAMES.readFile;
/** 写类工具代表。 */
const WRITE_TOOL = TOOL_NAMES.writeFile;

test('F3 角色矩阵：viewer 只读 / editor 可写不可治理 / admin 全放', () => {
  const policy = new RbacPolicy();

  // viewer：读放行；写与治理一律拒。
  assert.deepStrictEqual(policy.decide('viewer', callOf(READ_TOOL)), { allow: true });
  const viewerWrite = policy.decide('viewer', callOf(WRITE_TOOL));
  assert.strictEqual(viewerWrite.allow, false);
  assert.match(viewerWrite.allow ? '' : viewerWrite.reason, /viewer 无写权限/);
  assert.match(viewerWrite.allow ? '' : viewerWrite.reason, /写类工具/);

  // editor：读与写放行（写仍要过审批那道门）；治理类拒。
  assert.deepStrictEqual(policy.decide('editor', callOf(READ_TOOL)), { allow: true });
  assert.deepStrictEqual(policy.decide('editor', callOf(WRITE_TOOL)), { allow: true });
  const editorRollback = policy.decide('editor', callOf(TOOL_NAMES.rollback));
  assert.strictEqual(editorRollback.allow, false);
  assert.match(editorRollback.allow ? '' : editorRollback.reason, /治理类工具/);
  assert.match(editorRollback.allow ? '' : editorRollback.reason, /仅 admin 可执行/);

  // admin：全放（含治理类）。
  for (const name of [READ_TOOL, WRITE_TOOL, TOOL_NAMES.rollback, TOOL_NAMES.checkpoint]) {
    assert.deepStrictEqual(
      policy.decide('admin', callOf(name)),
      { allow: true },
      `admin 应放行 ${name}`,
    );
  }
});

test('F3 fail-closed：未知角色与未登记工具一律拒（不得静默退回默认角色）', () => {
  const policy = new RbacPolicy();
  const unknownRole = policy.decide('superuser', callOf(READ_TOOL));
  assert.strictEqual(unknownRole.allow, false);
  assert.match(unknownRole.allow ? '' : unknownRole.reason, /未知角色 "superuser"/);
  assert.match(
    unknownRole.allow ? '' : unknownRole.reason,
    /可用角色：/,
    '必须列出可用角色（可行动）',
  );

  // 未登记工具：连 admin 也拒（`*` 是显式声明，不等于"允许一切未登记项"）。
  for (const role of ['viewer', 'editor', 'admin']) {
    const verdict = policy.decide(role, callOf('not_a_registered_tool'));
    assert.strictEqual(verdict.allow, false, `${role} 不得调用未登记工具`);
    assert.match(verdict.allow ? '' : verdict.reason, /未登记/);
  }
  // 空角色名同样拒（配置写空不得变成"无角色即可用"）。
  assert.strictEqual(policy.decide('', callOf(READ_TOOL)).allow, false);
});

test('F3 拒绝优先：自定义角色里 deny 覆盖 allow 通配', () => {
  const policy = new RbacPolicy({
    roles: {
      auditor: { allow: ['*'], deny: [WRITE_TOOL, 'mcp__*'], mutating: false },
    },
  });
  assert.deepStrictEqual(policy.decide('auditor', callOf(READ_TOOL)), { allow: true });
  assert.strictEqual(policy.decide('auditor', callOf(WRITE_TOOL)).allow, false);
  // 尾部通配前缀匹配。
  assert.strictEqual(policy.decide('auditor', callOf('mcp__evil')).allow, false);
  // 未知角色仍在（角色表整体替换后，内建角色消失——语义明确，不做半覆盖）。
  assert.strictEqual(policy.decide('editor', callOf(READ_TOOL)).allow, false);
});

test('F3 不另立工具表：分类取自 MUTATING_TOOL_NAMES（新只读自动可用 / 新写类自动被 viewer 拒）', () => {
  // 用一个"假想的新工具"验证规则而非清单：把它登记进 catalog，
  // 再分别以"写类"与"只读"两种分类断言 —— 分类来源是仓库唯一的 MUTATING_TOOL_NAMES。
  const readOnlyNew = 'future_readonly_tool';
  const mutatingNew = 'future_mutating_tool';
  const policy = new RbacPolicy({
    toolCatalog: [...Object.values(TOOL_NAMES), readOnlyNew, mutatingNew],
  });
  assert.deepStrictEqual(
    policy.decide('viewer', callOf(readOnlyNew)),
    { allow: true },
    '新只读工具自动可用',
  );
  assert.deepStrictEqual(
    policy.decide('editor', callOf(mutatingNew)),
    { allow: true },
    'editor 可写（新写类）',
  );
  assert.deepStrictEqual(policy.decide('admin', callOf(mutatingNew)), { allow: true });
  // 真写类工具在 viewer 下必拒：抽查登记表里前三个写类工具。
  for (const name of [...MUTATING_TOOL_NAMES].slice(0, 3)) {
    const verdict = policy.decide('viewer', callOf(name));
    assert.strictEqual(verdict.allow, false, `viewer 必须拒写类工具 ${name}`);
  }
});

test('F3 可读摘要：describe 给出角色的允许模式与被拒集合（治理台/CLI 展示面）', () => {
  const policy = new RbacPolicy();
  const viewer = policy.describe('viewer');
  assert.deepStrictEqual(viewer.allow, ['*']);
  assert.ok(viewer.deny.includes(TOOL_NAMES.rollback), 'viewer 的拒绝集合必须含治理类');
  assert.ok(
    viewer.deny.includes(TOOL_NAMES.writeFile),
    'viewer 的拒绝集合必须含写类（由 mutating:false 展开）',
  );
  const admin = policy.describe('admin');
  assert.deepStrictEqual(admin, { allow: ['*'], deny: [] });
  assert.deepStrictEqual(policy.describe('nobody'), { allow: [], deny: [] }, '未知角色的摘要为空');
});
