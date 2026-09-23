import { Agent } from '../src/core/agent.js';
import { createRuntime } from '../src/composition/runtime.js';
import { ConfigFactory } from '../src/config/configFactory.js';
import { MockModel } from '../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../src/adapters/sandbox/passthroughSandbox.js';

/**
 * 压测：连续多会话运行，检查**保留量**增长（验收：无泄漏）。
 *
 * 测法要点（2026-09-19 修正，此前是假红）：
 * - **先预热一回合再取基线**：首回合会一次性建 repo-map 语料索引（实测 +70MB），
 *   若把基线取在预热前，这笔一次性成本会被误判成泄漏。
 * - **强制 GC 后测量**：V8 延迟回收的垃圾与泄漏不是一回事（实测未 GC 时多出 ~130MB）。
 *   故 `npm run stress` 以 `--expose-gc` 运行；缺该开关时给出显式不可判定提示，不假装通过。
 */
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
  const agent = new Agent(createRuntime(config));

  // 预热：把一次性索引 / 懒装配成本排除在基线之外。
  await agent.runTask('压测预热');
  collect();

  const rounds = 200;
  const baseline = process.memoryUsage().heapUsed;
  for (let index = 0; index < rounds; index += 1) {
    await agent.runTask(`压测任务 ${index}`);
  }
  const gcAvailable = collect();
  const after = process.memoryUsage().heapUsed;
  const growthMb = (after - baseline) / 1024 / 1024;

  process.stdout.write(`会话数: ${rounds}\n`);
  process.stdout.write(`基线堆（预热后）: ${(baseline / 1024 / 1024).toFixed(1)} MB\n`);
  process.stdout.write(`结束后堆: ${(after / 1024 / 1024).toFixed(1)} MB\n`);
  process.stdout.write(`保留量增长: ${growthMb.toFixed(1)} MB\n`);

  if (!gcAvailable) {
    process.stdout.write(
      '压测不可判定：未强制 GC（请用 `npm run stress`，其带 --expose-gc）——不假装通过，也不制造假红 ⚠️\n',
    );
    return;
  }
  if (growthMb > 100) {
    process.stdout.write('压测失败：疑似内存泄漏 ❌\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('压测通过：无内存泄漏 ✅\n');
  }
}

/**
 * 尽力强制 GC。
 *
 * @returns 是否真的执行了 GC（无 `--expose-gc` 时为 false，调用方据此拒绝下结论）。
 */
function collect(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    return false;
  }
  gc();
  return true;
}

runStress().catch((error: unknown) => {
  console.error(`压测失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
