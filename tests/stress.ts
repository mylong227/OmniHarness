import { Agent } from '../src/core/agent.js';
import { RuntimeFactory } from '../src/core/runtime.js';
import { ConfigFactory } from '../src/config/omniharnessConfig.js';
import { MockModel } from '../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../src/adapters/sandbox/passthroughSandbox.js';

/** 压测：连续多会话运行，检查内存增长（验收：无泄漏）。 */
async function runStress(): Promise<void> {
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const agent = new Agent(RuntimeFactory.create(config));

  const rounds = 200;
  const baseline = process.memoryUsage().heapUsed;
  for (let index = 0; index < rounds; index += 1) {
    await agent.runTask(`压测任务 ${index}`);
  }
  const after = process.memoryUsage().heapUsed;
  const growthMb = (after - baseline) / 1024 / 1024;

  process.stdout.write(`会话数: ${rounds}\n`);
  process.stdout.write(`基线堆: ${(baseline / 1024 / 1024).toFixed(1)} MB\n`);
  process.stdout.write(`结束后堆: ${(after / 1024 / 1024).toFixed(1)} MB\n`);
  process.stdout.write(`增长: ${growthMb.toFixed(1)} MB\n`);

  const leak = growthMb > 100;
  if (leak) {
    process.stdout.write('压测失败：疑似内存泄漏 ❌\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('压测通过：无内存泄漏 ✅\n');
  }
}

runStress().catch((error: unknown) => {
  console.error(`压测失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
