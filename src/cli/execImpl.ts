/**
 * execImpl.ts —— OmniHarness CLI 命令实现（god-class 拆分后的实体层）。
 *
 * 自续十七→十九 起，原 2152 行 ExecCli 已拆分为继承链：
 *   cliBuildConfig（配置装配 / 共享接线）
 *     → cliServerCmds（server/schema/doctor/auth/identity/daemon/serve）
 *     → cliMcpCmds（mcp serve/list/call）
 *     → cliDataCmds（session/plugin/audit/compare/kv/vault）
 *     → cliNativeCmds（native/lsp）
 *     → cliAgentCmds（execute/goal/workflow/routines/tui/eval）
 *     → ExecCli（本文件，仅生命周期 + 子命令分发）
 *
 * 冷启动优化（2026-09-04 实测，见 benchmark/efficiency_benchmark.mjs）：
 *   整条继承链的静态加载耗时 ~685ms（Node 基线 ~152ms 之上），是冷启动唯一瓶颈。
 *   因此本文件**不再作为进程入口**，改由 exec.ts（薄入口）按需动态 import。
 *   `--version` / `--help` 等无需执行引擎的路径不再加载本文件。
 */

import { execFileSync } from 'node:child_process';
import { Agent } from '../core/agent.js';
import { createRuntime } from '../core/runtime.js';
import { JsonlWriter } from '../output/jsonlWriter.js';
import { configFile } from '../config/configFile.js';
import type { CliArgs } from './args.js';
import { parseArgs, printUsage, messageOf, configDefaults } from './args.js';
import { CliAgentCmds } from './cliAgentCmds.js';

/** OmniHarness CLI 命令入口：omniharness exec / server … */
export class ExecCli extends CliAgentCmds {
  /** 执行并返回进程退出码。 */
  public async run(argv: readonly string[]): Promise<number> {
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(`omniharness ${(await import('../version.js')).API_VERSION}\n`);
      return 0;
    }
    if (argv[0] === 'server') {
      return this.runServer(argv.slice(1));
    }
    if (argv[0] === 'serve') {
      return this.runServe(argv.slice(1));
    }
    if (argv[0] === 'schema') {
      return this.runSchema(argv.slice(1));
    }
    if (argv[0] === 'session') {
      return this.runSession(argv.slice(1));
    }
    if (argv[0] === 'plugin') {
      return this.runPlugin(argv.slice(1));
    }
    if (argv[0] === 'profile') {
      return this.runProfile(argv.slice(1));
    }
    if (argv[0] === 'bundle') {
      return this.runBundle(argv.slice(1));
    }
    if (argv[0] === 'doctor') {
      return this.runDoctor(argv.slice(1));
    }
    if (argv[0] === 'compare') {
      return this.runCompare(argv.slice(1));
    }
    if (argv[0] === 'eval') {
      return this.runEval(argv.slice(1));
    }
    if (argv[0] === 'mcp') {
      return this.runMcp(argv.slice(1));
    }
    if (argv[0] === 'kv') {
      return this.runKv(argv.slice(1));
    }
    if (argv[0] === 'vault') {
      return this.runVault(argv.slice(1));
    }
    if (argv[0] === 'native') {
      return this.runNative(argv.slice(1));
    }
    if (argv[0] === 'goal') {
      return this.runGoal(argv.slice(1));
    }
    if (argv[0] === 'workflow') {
      return this.runWorkflow(argv.slice(1));
    }
    if (argv[0] === 'lsp') {
      return this.runLsp(argv.slice(1));
    }
    if (argv[0] === 'identity') {
      return this.runIdentity(argv.slice(1));
    }
    if (argv[0] === 'daemon') {
      return this.runDaemon(argv.slice(1));
    }
    if (argv[0] === 'routines') {
      return this.runRoutines(argv.slice(1));
    }
    if (argv[0] === 'tui') {
      return this.runTui(argv.slice(1));
    }
    if (argv[0] === 'audit') {
      return this.runAudit(argv.slice(1));
    }
    if (argv[0] === 'auth') {
      return this.runAuth(argv.slice(1));
    }
    let restoreEgress: () => void = () => {};
    try {
      const defaults = this.loadDefaults(argv);
      const args = parseArgs(argv, defaults);
      if (args === undefined) {
        printUsage();
        return 2;
      }
      restoreEgress = this.applyNetworkGuard(args);
      if (args.dumpConfig) {
        process.stdout.write(`${JSON.stringify(args, null, 2)}\n`);
        return 0;
      }
      const config = await this.buildConfig(args);
      if (args.print === true) {
        this.assertHeadlessSafe(args);
      }
      const agent = new Agent(createRuntime(config));
      const result = await this.execute(agent, args);
      if (args.output !== undefined) {
        const writer = new JsonlWriter(args.output);
        await writer.writeAll(result.events);
      }
      const summary = result.summary as {
        finalText?: string;
        sessionId?: string;
        steps?: number;
      };
      if (args.outputFormat === 'json') {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            sessionId: summary.sessionId,
            steps: summary.steps,
            finalText: summary.finalText ?? '',
          })}\n`,
        );
      } else if (args.streamText === true) {
        // V2.1（A1）：正文已随流式增量打到 stdout，这里只收尾换行，避免重复打印。
        process.stdout.write('\n');
      } else {
        process.stdout.write(`${summary.finalText ?? JSON.stringify(result.summary)}\n`);
      }
      if (args.autoCommit) {
        await this.maybeAutoCommit(summary.finalText ?? '');
      }
      return 0;
    } catch (error) {
      console.error(`OmniHarness执行失败: ${messageOf(error)}`);
      return 1;
    } finally {
      restoreEgress();
      this.closeGateway();
    }
  }

  /** 关闭 MCP 网关子进程（若已连接）。 */
  private closeGateway(): void {
    this.gateway?.close();
    this.gateway = undefined;
  }

  /**
   * headless（--print / -p）可用性校验：拦截一切需要 stdin 的交互配置。
   *
   * CI 环境的真实陷阱不是输出格式，而是**交互审批会永久挂起**——
   * `approval=ask` / `escalation=ask` 在没有 stdin 的流水线里会一直等待人输入，
   * 表现为「任务卡住」而非报错，极难排查。此处 fail-closed 显式失败并给出可自愈的提示。
   */
  private assertHeadlessSafe(args: CliArgs): void {
    const interactive: string[] = [];
    if (args.approval === 'ask') {
      interactive.push('--approval ask');
    }
    if (args.escalation === 'ask') {
      interactive.push('--escalation ask');
    }
    if (interactive.length > 0) {
      throw new Error(
        `headless 模式（--print）不支持交互审批：${interactive.join(' / ')} 在无 stdin 环境会永久挂起。` +
          `请改用 --approval rules|auto|deny 与 --escalation deny|auto。`,
      );
    }
  }

  /**
   * Aider 式安全网：执行后若处于 git 仓库则自动提交变更（opt-in；失败静默，不破坏主流程退出码）。
   */
  private async maybeAutoCommit(finalText: string): Promise<void> {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    } catch {
      return;
    }
    try {
      execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
      const message = `OmniHarness: ${finalText.slice(0, 72).replace(/\s+/g, ' ').trim() || 'auto-commit'}`;
      execFileSync('git', ['commit', '-m', message], { stdio: 'ignore' });
      process.stderr.write('已自动提交变更（--auto-commit）\n');
    } catch {
      // 无变更可提交或提交被钩子拒绝：忽略
    }
  }

  /**
   * 加载分层配置为默认参数（#G6：用户级 → 项目级 → profile → 环境变量，严格校验）。
   * 配置存在但非法时 loadLayered 抛 ConfigError，由 run() 的 catch 统一以非零码退出（fail-closed）。
   */
  private loadDefaults(argv: readonly string[]): Partial<CliArgs> | undefined {
    const explicitConfig = this.flagValue(argv, '--config');
    const profile = this.flagValue(argv, '--profile');
    if (explicitConfig === undefined && configFile.find(process.cwd()) === undefined) {
      process.stderr.write(
        '[omniharness] 未找到 omniharness.json，使用内置默认配置（mock 模型）。\n',
      );
      process.stderr.write(
        '              可复制 omniharness.json.example，或运行 node scripts/init-config.mjs 生成。\n',
      );
    }
    const merged = configFile.loadLayered({
      workspace: process.cwd(),
      configPath: explicitConfig,
      profile,
    });
    return configDefaults(merged);
  }
}
