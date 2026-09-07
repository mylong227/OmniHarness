// 内置冒烟评估套件：开箱即用，使 `omniharness eval` 无需外部文件即可回归验证基础运行时。
//
// 覆盖：① 三步工具链路（read_file → shell → write_file）验证工具执行 + 沙箱 + 事件记录；
// ② 纯文本应答验证无工具路径；并各自带期望断言（工具名 / 终态文本 / 写出文件）。

import type { EvalSuite } from './evalHarness.js';

/**
 * @beta
 * 内置 smoke 套件。
 */
export const SMOKE_SUITE: EvalSuite = {
  name: 'smoke',
  description: 'OmniHarness 内置冒烟评估：基础工具链路 + 纯文本应答',
  tasks: [
    {
      id: 'read-process-write',
      description: 'read_file → shell → write_file 三步工具链路（验证工具执行/沙箱/事件）',
      prompt: '读取 input.txt，处理后把结果写入 output.txt',
      seedFiles: { 'input.txt': 'line1\nline2\nline3\n' },
      script: [
        { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'input.txt' } }] },
        {
          toolCalls: [
            { id: 'c2', name: 'shell', arguments: { command: 'echo PROCESSED-OK-12345' } },
          ],
        },
        {
          toolCalls: [
            {
              id: 'c3',
              name: 'write_file',
              arguments: { path: 'output.txt', content: 'PROCESSED-OK-12345' },
            },
          ],
        },
        { text: '处理完成，结果 PROCESSED-OK-12345 已写入 output.txt' },
      ],
      expect: {
        tools: ['read_file', 'shell', 'write_file'],
        text: 'PROCESSED-OK-12345',
        files: { 'output.txt': 'PROCESSED-OK-12345' },
      },
    },
    {
      id: 'plain-greeting',
      description: '无工具调用的纯文本应答路径',
      prompt: '用一句话打招呼',
      script: [],
      finalText: '你好，我是 OmniHarness。',
      expect: { text: '你好' },
    },
  ],
};
