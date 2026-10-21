// 2026-10-21：原生工具接管门禁（原 #72 别名桥的收敛）。
//
// 背景：`--native` 默认开，而内核内置的 fs.read_file / fs.write_file / fs.list_dir
// 与 JS 工具**语义不等价**（忽略 offset/limit、无行号/64MiB 上限、无 .bak/mkdir -p、
// 不写 FileContentLedger；list_dir 还是 JSON 格式）。直接按名字路由会让默认路径静默失真。
//
// 现在的契约：
//  - `NativeBackend.supports()` 对全部 JS 工具恒 false ⇒ StepToolExecutor 跳过原生执行；
//  - 别名表为空 ⇒ 即使有人直接 `runTool('read_file')`，内核也只会报「工具不存在」，
//    绝不可能被当成 fs.read_file 执行；
//  - 未知工具仍不被静默执行。
//
// 内核不可用时整体 skip（与 nativeTokenEstimator.test.ts 一致）。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../src/native/nativeBackend.ts';
import { RequireEnv } from '../helpers/requireEnv.ts';
import type { ToolCall } from '../../src/ports/tool/tool.ts';

const native = NativeBackend.tryCreate();
const skip = RequireEnv.skipUnlessBool(
  'OMNI_REQUIRE_NATIVE',
  native !== undefined,
  '原生内核不可用（请先 npm run native:build）',
);

function call(name: string, args: Record<string, unknown>, id = 'c1'): ToolCall {
  return { id, name, arguments: args } as ToolCall;
}

test('原生后端不得声明接管 fs / shell 工具（语义尚不等价）', { skip }, () => {
  for (const name of ['read_file', 'write_file', 'list_dir', 'shell']) {
    assert.strictEqual(
      native!.supports(name),
      false,
      `${name} 尚未做到与 JS 工具逐字节等价，supports() 必须为 false`,
    );
  }
});

test('fs 工具名不再被翻译成内核方言：直接调用只会报工具不存在', { skip }, () => {
  // 若别名桥被误加回来，这里会成功返回整文件内容（read_file 的 offset/limit 会被吞掉）。
  assert.throws(
    () => native!.runTool(call('read_file', { path: 'package.json', offset: 1, limit: 1 })),
    /工具不存在|原生内核执行失败/,
    'read_file 不得被内核接管',
  );
});

test('未知工具仍不被静默当成原生工具执行', { skip }, () => {
  let rejectedOrThrown = false;
  try {
    const r = native!.runTool(call('no_such_tool_xyz', {}));
    if (r.ok === false) rejectedOrThrown = true;
  } catch {
    rejectedOrThrown = true;
  }
  assert.strictEqual(rejectedOrThrown, true, '未知工具不应被当成原生工具执行');
});
