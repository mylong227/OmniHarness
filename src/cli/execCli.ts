/**
 * execImpl.ts —— OmniHarness CLI 命令实现（god-class 拆分后的实体层）。
 *
 * 自续十七→十九 起，原 2152 行 ExecCli 已拆分为继承链：
 *   cliBuildConfig（配置装配 / 共享接线）
 *     → cliServerCmds（server/schema/doctor/auth/identity/daemon/serve）
 *     → cliMcpCmds（mcp serve/list/call）
 *     → cliDataCmds（session/plugin/audit/compare/kv/vault）
 *     → cliNativeCmds（native/lsp）
 *     → cliAgentCmds（execute/goal/workflow/routines/tui）
 *     → ExecCli（本文件，仅生命周期 + 子命令分发）
 *
 * 冷启动优化（2026-09-04 实测，见 benchmark/efficiency_benchmark.mjs）：
 *   整条继承链的静态加载耗时 ~685ms（Node 基线 ~152ms 之上），是冷启动唯一瓶颈。
 *   因此本文件**不再作为进程入口**，改由 exec.ts（薄入口）按需动态 import。
 *   `--version` / `--help` 等无需执行引擎的路径不再加载本文件。
 */

import { AsyncChildProcess } from '../util/asyncChildProcess.js';
import { join } from 'node:path';
import { Agent } from '../core/agent.js';
import { Runtime } from '../composition/runtime.js';
import { JsonlWriter } from '../output/jsonlWriter.js';
import { configFile } from '../config/configFile.js';
import type { CliArgs } from './argParser.js';
import { ArgParser } from './argParser.js';
import { CliAgentCmds } from './cliAgentCmds.js';
import { EvolutionCommand } from './evolutionCommand.js';
import { CapabilityCommand } from './capabilityCommand.js';
import { LicenseCommand } from './licenseCommand.js';
import { AssetPackInstaller } from '../asset/assetPackInstaller.js';
import { IsolationLadderFactory } from '../adapters/isolation/isolationLadderFactory.js';
import { HashChainPromotionLedger } from '../evolution/hashChainPromotionLedger.js';
import type { AssetPackPort } from '../ports/asset.js';
import type { CapabilityStack } from '../ports/config/capabilityStack.js';

/** 可报告体检的进化控制器（Kernel 与 RLVR 控制器都实现 `report()`；`EvolutionController` 端口未声明它）。 */
interface ReportableController {
  /** 最近一轮体检报告（未跑过为 undefined）。 */
  report?(): unknown;
}

/** OmniHarness CLI 命令入口：omniharness exec / server … */
export class ExecCli extends CliAgentCmds {
  /** evolution 子命令（S7）：status/rollback 自持，cycle 经本层注入的钩子执行。 */
  private readonly evolutionCommand = new EvolutionCommand((request) =>
    this.runEvolutionCycle(request),
  );
  /** license 子命令（F1）：查看本机授权档位（纯校验，无副作用）。 */
  private readonly licenseCommand = new LicenseCommand();
  /** capability 子命令（Wave B/D）：只读 list/metadata + 写操作 install（切片与安装器都由本层装配）。 */
  private readonly capabilityCommand = new CapabilityCommand(
    () => this.capabilityStackOf(),
    () => this.assetPackInstallerOf(),
  );
  /**
   * 执行并返回进程退出码。
   * @param argv 原始命令行参数（不含 node 与脚本入口）。
   * @returns 进程退出码：子命令各自决定；exec 主路径成功 0、用法错误 2、执行异常 1。
   */
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
    if (argv[0] === 'mcp') {
      return this.runMcp(argv.slice(1));
    }
    if (argv[0] === 'license') return this.licenseCommand.run(argv.slice(1));
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
    if (argv[0] === 'trace') {
      return this.runTrace(argv.slice(1));
    }
    if (argv[0] === 'sdk') {
      return this.runSdk(argv.slice(1));
    }
    if (argv[0] === 'auth') {
      return this.runAuth(argv.slice(1));
    }
    if (argv[0] === 'evolution') return this.runEvolution(argv.slice(1));
    if (argv[0] === 'capability') return this.runCapability(argv.slice(1));
    let restoreEgress: () => void = () => {};
    try {
      const defaults = this.loadDefaults(argv);
      const args = ArgParser.parseArgs(argv, defaults);
      if (args === undefined) {
        ArgParser.printUsage();
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
      const agent = new Agent(Runtime.createRuntime(config));
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
      console.error(`OmniHarness执行失败: ${ArgParser.messageOf(error)}`);
      return 1;
    } finally {
      restoreEgress();
      this.closeGateway();
    }
  }

  /**
   * headless（--print / -p）可用性校验：拦截一切需要 stdin 的交互配置。
   *
   * CI 环境的真实陷阱不是输出格式，而是**交互审批会永久挂起**——
   * `approval=ask` / `escalation=ask` 在没有 stdin 的流水线里会一直等待人输入，
   * 表现为「任务卡住」而非报错，极难排查。此处 fail-closed 显式失败并给出可自愈的提示。
   * @param args 解析后的 CLI 参数（检查 approval / escalation 是否为 ask）。
   
 * @returns 无返回值。
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
   * @param finalText 本次执行的最终答复文本（截断 72 字符作为提交信息）。
   
 * @returns 无返回值。
*/
  private async maybeAutoCommit(finalText: string): Promise<void> {
    try {
      await AsyncChildProcess.execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        stdio: 'ignore',
      });
    } catch {
      return;
    }
    try {
      await AsyncChildProcess.execFileAsync('git', ['add', '-A'], { stdio: 'ignore' });
      const message = `OmniHarness: ${finalText.slice(0, 72).replace(/\s+/g, ' ').trim() || 'auto-commit'}`;
      await AsyncChildProcess.execFileAsync('git', ['commit', '-m', message], { stdio: 'ignore' });
      process.stderr.write('已自动提交变更（--auto-commit）\n');
    } catch {
      // 无变更可提交或提交被钩子拒绝：忽略
    }
  }

  /**
   * evolution 子命令入口（S7）。
   * @param args 子命令参数（已去掉 `evolution`）。
   * @returns 进程退出码（status/rollback 由 `EvolutionCommand` 决定；cycle 见下）。
   */
  private async runEvolution(args: readonly string[]): Promise<number> {
    return this.evolutionCommand.run(args);
  }

  /**
   * capability 子命令入口（Wave B · ADR-0009）：只读列出资产协议面。
   *
   * 装配仍在**本层**（同 `evolution cycle` 的理由：只有本层持有 `loadDefaults` + `buildConfig`），
   * 命令类只拿一个只读回调 ⇒ 结构性只读（它没有写入口，想写也写不了）。
   * @param args 子命令参数（已去掉 `capability`）。
   * @returns 进程退出码（list 见命令类；未启用为 1）。
   */
  private async runCapability(args: readonly string[]): Promise<number> {
    return this.capabilityCommand.run(args);
  }

  /**
   * 取资产协议切片（只读；供 `capability list` 用）。
   *
   * `capability.enabled !== true` 时返回 undefined（命令类如实报「未启用」而不是打空表）。
   * 配置装载/装配失败时同样返回 undefined——只读命令不该因为一个坏配置把整个 CLI 打挂。
   * @returns 资产协议切片或 undefined
   */
  private async capabilityStackOf(): Promise<CapabilityStack | undefined> {
    try {
      const defaults = this.loadDefaults([]);
      const args = ArgParser.parseArgs(['--prompt', 'capability list'], defaults);
      if (args === undefined) return undefined;
      return (await this.buildConfig(args)).capabilityStack;
    } catch {
      return undefined;
    }
  }

  /**
   * 造资产包安装器（Wave D · ADR-0011）：在**组合点**把「切片 + 台账」接起来。
   *
   * 台账位置与 Kernel 路径同一口径（`<workspace>/<ledgerDir>/ledger.jsonl`，默认 `.omniharness/evolution`）——
   * 安装事件与晋升/治理事件落在**同一条链**上（无账不生效：台账不可用即拒装，由安装器负责）。
   * @returns 安装器；`capability.enabled !== true` 或配置不可用时 undefined
   */
  private async assetPackInstallerOf(): Promise<AssetPackPort | undefined> {
    const stack = await this.capabilityStackOf();
    if (stack === undefined) return undefined;
    try {
      const defaults = this.loadDefaults([]);
      const args = ArgParser.parseArgs(['--prompt', 'capability install'], defaults);
      if (args === undefined) return undefined;
      const config = await this.buildConfig(args);
      const dir = join(
        config.workspaceRoot,
        config.evolutionRlvr?.ledgerDir ?? join('.omniharness', 'evolution'),
      );
      return new AssetPackInstaller({
        registry: stack.registry,
        schemas: stack.schemas,
        ledger: new HashChainPromotionLedger({ dir }),
        defaults: stack.defaults,
        // Wave C · ADR-0010：装包前做「档位可达性门禁 + in-process 冒烟」——
        // 声明了本机不可达档位的包一律拒装，绝不降档凑合。
        // (J8) 用工厂装配：`wasm` 档由内置 `BuiltinWasmRunner` 提供（零新依赖）；
        // 漏注入会让"声明了 wasm 的包"被静默拒装，症状只是"装不上"，排查方向容易跑偏。
        isolation: IsolationLadderFactory.builtin(),
      });
    } catch {
      return undefined;
    }
  }

  /**
   * `evolution cycle` 的装配钩子（S7）：会话外真跑一轮进化。
   *
   * 为什么在本层：只有本层同时持有 `loadDefaults`（私有）与 `buildConfig`，能在不动 `core/` 的前提下
   * 装出一份运行时并调用 `runtime.evolution.cycle()`——这正是 `Agent.runEvolutionIfEnabled` 在会话内
   * 做的那一步，此处只是把它搬到 CLI。
   *
   * **诚实边界（输出的 `note` 字段）**：晋升落在**本进程内存**的技能表（会话级），随进程退出消失；
   * 台账（快照/晋升条目）是持久产物。要长期生效，把还原/晋升产物经 `--skills` 接回下一次会话。
   * @param request 钩子请求（原始旗标 + 输出格式；`--yes` 已由 `EvolutionCommand` 校验）
   * @returns 0 成功；1 未启用或运行时不可用；2 参数问题
   */
  private async runEvolutionCycle(request: {
    readonly argv: readonly string[];
    readonly json: boolean;
  }): Promise<number> {
    // `ArgParser` 把「无 prompt 且无 replayId」判为无任务；cycle 不跑 agent，故给一条占位 prompt。
    const argv = request.argv.length > 0 ? request.argv : ['--prompt', 'evolution cycle'];
    const defaults = this.loadDefaults(argv);
    const args = ArgParser.parseArgs(argv, defaults);
    if (args === undefined) {
      ArgParser.printUsage();
      return 2;
    }
    const config = await this.buildConfig(args);
    const runtime = Runtime.createRuntime(config);
    const controller = runtime.evolution;
    if (controller === undefined) {
      process.stderr.write(
        'evolution 未启用（配置 evolutionRlvr.enabled / --evolution-rlvr 未开），无可跑的闭环。\n',
      );
      return 1;
    }
    const verdicts = await controller.cycle();
    const report = (controller as unknown as ReportableController).report?.();
    const summary = {
      ok: true,
      autoRun: controller.autoRun,
      evaluated: verdicts.length,
      promoted: verdicts.filter((v) => v.promoted).length,
      report,
      note: '晋升落在本进程内存技能表（会话级）；台账为持久产物。',
    };
    process.stdout.write(
      request.json
        ? `${JSON.stringify(summary)}\n`
        : `进化一轮：评估 ${summary.evaluated} ｜ 晋升 ${summary.promoted}\n` +
            `  体检：${JSON.stringify(report)}\n  注意：${summary.note}\n`,
    );
    return 0;
  }

  /**
   * 加载分层配置为默认参数（#G6：用户级 → 项目级 → profile → 环境变量，严格校验）。
   * 配置存在但非法时 loadLayered 抛 ConfigError，由 run() 的 catch 统一以非零码退出（fail-closed）。
   * @param argv 原始命令行参数（读取 --config / --profile 显式覆盖）。
   * @returns 配置文件字段映射出的 CLI 默认值子集；找不到配置文件时使用内置默认（mock 模型）。
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
    return ArgParser.configDefaults(merged);
  }
}
