import { ContextCompactor } from '../../src/context/contextCompactor.js';
import { TokenEstimator } from '../../src/context/tokenEstimator.js';
import type { ModelMessage } from '../../src/ports/model.js';

/** 压缩降幅基准：验证 M1 验收（长上下文 token 降 50%+）。 */
async function runBench(): Promise<void> {
  const estimator = new TokenEstimator();
  const messages: ModelMessage[] = Array.from({ length: 60 }, (_unused, index) => ({
    role: 'user',
    content: `第 ${index} 条消息：这是模拟长会话的历史内容，包含若干事实与用户意图的描述。${'x'.repeat(80)}`,
  }));

  const before = estimator.estimateMessages(messages);
  const compactor = new ContextCompactor(undefined, {
    maxTokens: 1000,
    keepRecent: 6,
    remoteSummarizer: async (history) =>
      `【服务端摘要】对话共 ${history.length} 字，要点：任务推进、关键决策记录。`,
  });
  const result = await compactor.compact(messages);
  const after = estimator.estimateMessages(result.messages);
  const reduction = (1 - after / before) * 100;

  process.stdout.write(`压缩前: ${before} token（${messages.length} 条消息）\n`);
  process.stdout.write(`压缩后: ${after} token（${result.messages.length} 条消息）\n`);
  process.stdout.write(`降幅: ${reduction.toFixed(1)}%\n`);
  process.stdout.write(`摘要来源: ${result.summary?.slice(0, 24)}…\n`);

  const passed = reduction >= 50 && result.compacted;
  if (passed) {
    process.stdout.write('基准通过：降幅 ≥ 50% ✅\n');
  } else {
    process.stdout.write('基准未达标 ❌\n');
    process.exitCode = 1;
  }
}

runBench().catch((error: unknown) => {
  console.error(`基准失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
