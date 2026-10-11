/**
 * cliCompareCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 4.5/6 层）。
 *
 * 承载 A/B 模型对比子命令簇：compare / compareSide / buildCompareConfig。
 * 从 CliDataCmds 中拆出以满足单文件行数上限（<400）；方法体逐字节等价，`private`→`protected`。
 * 继承自 CliDataCmds（故可复用其全部 build* / flagValue 助手），并被 CliNativeCmds 继承。
 */

import { CliDefaults, MODEL_ADAPTERS, CliFlagTable } from './argParser.js';
import type { CliArgs } from './argParser.js';
import { CliDataCmds } from './cliDataCmds.js';
import type { ResolvedConfig } from '../ports/config/resolvedConfig.js';

/** A/B 模型对比类子命令。 */
export class CliCompareCmds extends CliDataCmds {
  /**
   * A/B 模型对比：同一 prompt 两个模型分别执行。
   * @param args 子命令参数（--prompt 必填，--adapter-a/--adapter-b 等按侧取用）。
   * @returns 进程退出码：缺 --prompt 为 2，成功为 0（结果含两侧模型名/耗时/答复）。
   */
  protected async runCompare(args: readonly string[]): Promise<number> {
    const prompt = this.flagValue(args, '--prompt');
    if (prompt === undefined) {
      process.stdout.write(
        '用法: omniharness compare --prompt "任务" --adapter-a mock --adapter-b openai [--base-url-b URL --api-key-b KEY --model-b M]\n',
      );
      return 2;
    }
    const resultA = await this.runCompareSide(args, 'a', prompt);
    const resultB = await this.runCompareSide(args, 'b', prompt);
    process.stdout.write('=== A/B 对比 ===\n');
    process.stdout.write(
      `模型 A: ${resultA.modelName}｜耗时 ${resultA.durationMs}ms｜${resultA.finalText}\n`,
    );
    process.stdout.write(
      `模型 B: ${resultB.modelName}｜耗时 ${resultB.durationMs}ms｜${resultB.finalText}\n`,
    );
    return 0;
  }

  /**
   * 单侧运行。
   * @param args 子命令参数（按后缀读取该侧 adapter/baseUrl/apiKey/model）。
   * @param suffix 侧别后缀（'a' 或 'b'），用于拼接旗标名。
   * @param prompt 对比用的同一任务提示词。
   * @returns 该侧结果：模型名、耗时（ms）与最终答复。
   */
  protected async runCompareSide(
    args: readonly string[],
    suffix: string,
    prompt: string,
  ): Promise<{ modelName: string; durationMs: number; finalText?: string | undefined }> {
    const config = await this.buildCompareConfig(args, suffix);
    // 2026-10-11 启动成本（目标 (9)「CLI 子命令启动 ~2s」）：`Agent` + `Runtime` + `configFactory`
    // 合计净 ~1.2s，而 compare 是**冷门命令族**；顶层值导入让**每个**子命令（含 `kv list`）都付这份
    // ESM 解析成本 ⇒ 改成走到这里才加载。调用方零改动。
    const [{ Agent }, { Runtime }] = await Promise.all([
      import('../core/agent.js'),
      import('../composition/runtime.js'),
    ]);
    const agent = new Agent(Runtime.createRuntime(config));
    const startedAt = Date.now();
    const result = await agent.runTask(prompt);
    return {
      modelName: config.model.name,
      durationMs: Date.now() - startedAt,
      finalText: result.finalText,
    };
  }

  /**
   * 构建单侧对比配置。
   * @param args 子命令参数（按后缀读取该侧旗标）。
   * @param suffix 侧别后缀（'a' 或 'b'），用于拼接旗标名。
   * @returns 独立的对比配置（内存存储 + 自动审批 + 直通沙箱 + 静默事件）。
   */
  protected async buildCompareConfig(
    args: readonly string[],
    suffix: string,
  ): Promise<ResolvedConfig> {
    const adapter = this.flagValue(args, `--adapter-${suffix}`) ?? 'mock';
    const baseUrl = this.flagValue(args, `--base-url-${suffix}`);
    const apiKey = this.flagValue(args, `--api-key-${suffix}`);
    const model = this.flagValue(args, `--model-${suffix}`) ?? 'deepseek-v4-flash';
    const cliArgs: CliArgs = {
      ...CliDefaults,
      modelAdapter: CliFlagTable.checkEnum(adapter, `--adapter-${suffix}`, MODEL_ADAPTERS),
      baseUrl,
      apiKey,
      model,
    };
    const [
      { ConfigFactory },
      { MemoryStorage },
      { SilentEventPort },
      { AutoApproval },
      { PassthroughSandbox },
    ] = await Promise.all([
      import('../config/configFactory.js'),
      import('../adapters/storage/memoryStorage.js'),
      import('../adapters/event/silentEventPort.js'),
      import('../adapters/approval/autoApproval.js'),
      import('../adapters/sandbox/passthroughSandbox.js'),
    ]);
    return ConfigFactory.build({
      workspaceRoot: process.cwd(),
      maxSteps: 16,
      model: this.buildModel(cliArgs),
      storage: new MemoryStorage(),
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
    });
  }
}
