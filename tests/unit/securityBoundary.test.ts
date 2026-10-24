/**
 * **安全边界如实标注**的判据（G5，2026-10-03 第六轮）。
 *
 * ## 为什么要有它
 *
 * 看板 §8.5 登记了三处「声明强于实现」：① 默认沙箱档是纯 TS 策略（无内核强制）；② Windows 原生后端
 * 历史上 restricting-SID 计数为 0（2026-10-24 已升级为 `WRITE_RESTRICTED` 写隔离，但读/网络仍不隔离）；
 * ③ `networkEgressGuard` 只包 `globalThis.fetch` ⇒ shell 子进程完全绕过。**用户可感知的后果**是：模型若被注入说服，
 * `shell` 里的下载/外联命令在本机**不会**被拦住。
 *
 * 修法不是"把它说成能拦"（那是更糟的假安全），而是把**真实能力边界**变成可复核的诊断输出与数据：
 *  - `ToolOutputTrust` 新增 `memory` 档（阈值 1，与 `external` 同级）——记忆跨会话持久、来源不可追溯；
 *  - `NetworkEgressGuard.COVERAGE` 常量自述"只覆盖 fetch、不覆盖 shell"；
 *  - `SandboxCapabilityTable` 的 `restricted` 条目如实区分「原生写隔离」与「TS 策略层 / 读网络不隔离」；
 *  - `doctor` 增「隔离强度 / 网络守卫覆盖 / 注入护栏」三行，值全部取自上述单一事实来源。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DoctorRunner } from '../../src/cli/doctorRunner.ts';
import { NetworkEgressGuard } from '../../src/adapters/sandbox/networkEgressGuard.ts';
import { SandboxCapabilityTable } from '../../src/adapters/sandbox/sandboxCapabilityTable.ts';
import { ToolOutputTrust } from '../../src/security/toolOutputTrust.ts';

test('① 默认档（policy，纯 TS 策略）必须如实报 L2 且 kernelEnforced=false', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-sec-'));
  try {
    const report = DoctorRunner.runDoctor({ workspaceRoot: root });
    assert.strictEqual(
      report.security.sandboxProfile,
      'policy',
      '未配置时生效档就是 policy（appServerBase 的缺省），诊断不得报成别的',
    );
    assert.strictEqual(
      report.security.kernelEnforced,
      false,
      'policy 是纯 TS 黑名单 + 路径白名单，无内核强制',
    );
    assert.strictEqual(
      report.security.isolationLevel,
      'L2',
      '无内核强制 ⇒ 当前是 L2（同用户进程内约束）；报 L3 就是"声明强于实现"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('② bwrap 已接执行包装：真机可达才 L3，否则 L2', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-sec-'));
  try {
    writeFileSync(join(root, 'omniharness.json'), JSON.stringify({ sandbox: 'bwrap' }), 'utf8');
    const report = DoctorRunner.runDoctor({ workspaceRoot: root });
    assert.strictEqual(
      report.security.sandboxProfile,
      'bwrap',
      '诊断必须读工作区配置，而不是只报缺省',
    );
    assert.match(report.security.isolationBasis, /执行包装=已接/u);
    const entry = report.sandboxCapabilities.find((item) => item.profile === 'bwrap');
    if (entry?.real === true) {
      assert.strictEqual(report.security.isolationLevel, 'L3');
      assert.strictEqual(report.security.kernelEnforced, true);
    } else {
      assert.strictEqual(report.security.isolationLevel, 'L2');
      assert.strictEqual(report.security.kernelEnforced, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('③ 网络守卫必须自述"只覆盖 fetch、不覆盖 shell 出网"', () => {
  assert.strictEqual(NetworkEgressGuard.COVERAGE.shellSubprocessGuarded, false);
  assert.deepStrictEqual(NetworkEgressGuard.COVERAGE.surfaces, ['globalThis.fetch']);
  assert.ok(
    NetworkEgressGuard.COVERAGE.basis.includes('shell'),
    '自述依据里必须点名 shell 绕过这件事，否则读者仍会以为"网络已收口"',
  );
  const root = mkdtempSync(join(tmpdir(), 'omni-sec-'));
  try {
    const report = DoctorRunner.runDoctor({ workspaceRoot: root });
    assert.strictEqual(
      report.security.shellEgressGuarded,
      false,
      'doctor 必须把 shell 绕过如实转述',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('④ 记忆信任档已收紧：memory 档阈值 1（与 external 同级），且 doctor 可见', () => {
  assert.strictEqual(ToolOutputTrust.fromToolName('memory_search'), 'memory');
  assert.strictEqual(ToolOutputTrust.fromToolName('recall'), 'memory');
  assert.strictEqual(
    ToolOutputTrust.weakEvidenceThreshold('memory'),
    ToolOutputTrust.weakEvidenceThreshold('external'),
    '记忆必须与外部抓取同档：跨会话持久 + 来源不可追溯',
  );
  assert.strictEqual(ToolOutputTrust.weakEvidenceThreshold('file'), 2, '工作区文件档保持不变');
  const root = mkdtempSync(join(tmpdir(), 'omni-sec-'));
  try {
    const report = DoctorRunner.runDoctor({ workspaceRoot: root });
    assert.strictEqual(
      report.security.injectionThresholds.memory,
      1,
      'doctor 必须把收紧后的记忆档阈值显示出来',
    );
    assert.strictEqual(report.security.injectionMode, 'off', '缺省档是 off（只作诊断事实陈述）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⑤ 能力表把原生写隔离与完整 OS 隔离区分开', () => {
  const entries = SandboxCapabilityTable.describe(process.cwd(), { elevated: false });
  const restricted = entries.find((item) => item.profile === 'restricted');
  assert.ok(restricted !== undefined, 'restricted 条目必须存在');
  assert.ok(
    restricted!.basis.includes('写隔离') &&
      restricted!.basis.includes('读/网络仍不受限') &&
      restricted!.basis.includes('TS 执行链仍是策略层'),
    `restricted 的 basis 必须区分写隔离/读网络边界/TS 策略层，实际为：${restricted!.basis}`,
  );
});
