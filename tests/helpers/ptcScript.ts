import type { ModelOutput } from '../../src/ports/model.js';

/** 单次 run_code 程序：程序内循环调用 shell 3 次并汇总输出。 */
function codeOf(round: number): string {
  return [
    'const outputs = [];',
    'for (let i = 0; i < 3; i += 1) {',
    `  outputs.push(await call('shell', { command: 'echo ptc-${round}-' + i }));`,
    '}',
    'log(outputs.join("|"));',
    'return outputs.length;',
  ].join('\n');
}

/** 单次 run_code 调用。 */
function runCodeCall(round: number): ModelOutput {
  return {
    toolCalls: [{ id: `ptc-${round}`, name: 'run_code', arguments: { code: codeOf(round) } }],
  };
}

/** PTC 压测脚本：5 次 run_code（共 15 次程序内工具调用）+ 收尾文本。 */
export function ptcScript(): readonly ModelOutput[] {
  return [
    runCodeCall(1),
    runCodeCall(2),
    runCodeCall(3),
    runCodeCall(4),
    runCodeCall(5),
    { text: '组合压测完成' },
  ];
}
