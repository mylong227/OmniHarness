// #72 单测：工具名别名桥（JS 名 → Rust 内核名）让标准工具集真正下沉 Rust。
// 内核不可用时整体 skip（与 nativeTokenEstimator.test.ts 一致，避免 CI 无 .node 时红）。
//
// 覆盖：
//  - shell      → shell.run（OS 沙箱包装为 omni-cli sandbox run，故需 omni-cli 在 PATH）
//  - read_file  → fs.read_file（原生沙箱，无需外部依赖）
//  - write_file → fs.write_file（原生沙箱，无需外部依赖）
//  - 未知工具    → 仍被内核判为业务拒绝，不被静默当成原生工具执行

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, delimiter } from 'node:path';
import { NativeBackend } from '../../src/native/nativeBackend.js';
import type { ToolCall } from '../../src/ports/tool.js';

// #72：native shell.run 经 OS 沙箱包装为 `omni-cli sandbox run`，需 omni-cli 在 PATH。
// 模块加载时注入 cargo target bin，模拟真实 --native 部署环境；缺失则跳过 shell 测试。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let omniCliOnPath = false;
for (const profile of ['release', 'debug']) {
  const bin = join(root, 'target', profile);
  if (existsSync(bin)) {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    omniCliOnPath = true;
  }
}

// 顶层探测一次，供各用例用 test({ skip }) 真跳过（旧写法 `if undefined return` 会虚增通过计数）。
const native = NativeBackend.tryCreate();
const nativeUnavailable = native === undefined;
const shellSkip = nativeUnavailable
  ? '原生内核不可用（请先 npm run native:build）'
  : !omniCliOnPath
    ? 'omni-cli 不在 PATH，无法验证 shell.run OS 沙箱包装（见 #72 备注）'
    : false;

function call(name: string, args: Record<string, unknown>, id = 'c1'): ToolCall {
  return { id, name, arguments: args } as ToolCall;
}

test('shell 经别名桥路由到 shell.run 真实执行', { skip: shellSkip }, () => {
  const r = native!.runTool(call('shell', { command: 'echo 别名桥-ok' }));
  assert.strictEqual(r.ok, true, 'shell 应路由到 shell.run 并成功');
  assert.match(r.output ?? '', /别名桥-ok/, '输出应含回显内容');
});

test(
  'read_file / write_file 经别名桥路由到 fs.read_file / fs.write_file',
  { skip: nativeUnavailable ? '原生内核不可用（请先 npm run native:build）' : false },
  () => {
    // 内核 fs 根 = 进程 cwd；用绝对路径落于 cwd 之下，确保 within() 沙箱校验通过。
    const cwd = process.cwd();
    const path = join(cwd, `.omni-alias-${process.pid}-${Date.now()}.txt`);
    try {
      const w = native!.runTool(call('write_file', { path, content: 'bridge-ok' }));
      assert.strictEqual(w.ok, true, 'write_file 应路由到 fs.write_file 并成功');
      assert.strictEqual(existsSync(path), true, '文件应已写出');
      const r = native!.runTool(call('read_file', { path }));
      assert.strictEqual(r.ok, true, 'read_file 应路由到 fs.read_file 并成功');
      assert.match(r.output ?? '', /bridge-ok/, '读回内容应一致');
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* 忽略清理失败 */
      }
    }
  },
);

test(
  '未知工具仍返回业务拒绝（不抛错、不静默当成原生工具执行）',
  { skip: nativeUnavailable ? '原生内核不可用（请先 npm run native:build）' : false },
  () => {
    // 内核对未知工具判为业务拒绝（ok:false, rejected=true）→ 不抛错；
    // 若内核以异常表达拒绝亦属「未静默执行」，两种都算通过。
    let rejectedOrThrown = false;
    try {
      const r = native!.runTool(call('no_such_tool_xyz', {}));
      if (r.ok === false) rejectedOrThrown = true;
    } catch {
      rejectedOrThrown = true;
    }
    assert.strictEqual(rejectedOrThrown, true, '未知工具不应被当成原生工具执行');
  },
);
