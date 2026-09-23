import { Agent } from '../src/core/agent.js';
import { createRuntime } from '../src/composition/runtime.js';
import { ConfigFactory } from '../src/config/configFactory.js';
import { MemoryStorage } from '../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../src/adapters/sandbox/passthroughSandbox.js';
import { StressModel } from './helpers/stressModel.js';
import { ptcScript } from './helpers/ptcScript.js';

/** 读取事件 payload 字段（payload 类型为 unknown，需收敛）。 */
function fieldOf(event: { payload: unknown }, key: string): unknown {
  const payload = event.payload as Record<string, unknown> | undefined;
  return payload?.[key];
}

/** PTC × 压缩 组合压测：长会话 + 程序内多工具调用 + 强制压缩。 */
async function runPtcStress(): Promise<void> {
  const rounds = 20;
  const baseline = process.memoryUsage().heapUsed;
  let compactionCount = 0;
  let toolCalls = 0;
  let toolFailures = 0;

  for (let round = 0; round < rounds; round += 1) {
    const config = ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 12,
      model: new StressModel(ptcScript()),
      storage: new MemoryStorage(),
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
      compactionMaxTokens: 60,
    });
    const agent = new Agent(createRuntime(config));
    const result = await agent.runTask(`组合压测 ${round}`);
    for (const event of result.events) {
      if (event.type === 'system') {
        compactionCount += 1;
      }
      if (event.type === 'tool_result') {
        toolCalls += 1;
        if (fieldOf(event, 'ok') !== true) {
          toolFailures += 1;
        }
      }
    }
  }

  const growthMb = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
  process.stdout.write(`会话数: ${rounds}\n`);
  process.stdout.write(`压缩触发: ${compactionCount} 次\n`);
  process.stdout.write(`工具调用: ${toolCalls} 次（失败 ${toolFailures} 次）\n`);
  process.stdout.write(`堆增长: ${growthMb.toFixed(1)} MB\n`);

  const failures: string[] = [];
  if (compactionCount === 0) {
    failures.push('压缩未触发');
  }
  if (toolFailures > 0) {
    failures.push(`PTC 调用失败 ${toolFailures} 次`);
  }
  if (growthMb > 100) {
    failures.push(`疑似内存泄漏（${growthMb.toFixed(1)} MB）`);
  }
  if (failures.length > 0) {
    process.stdout.write(`组合压测失败：${failures.join('；')} ❌\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('组合压测通过：PTC × 压缩 组合链路无泄漏且结果正确 ✅\n');
}

runPtcStress().catch((error: unknown) => {
  console.error(`组合压测异常: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
