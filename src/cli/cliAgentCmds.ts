/**
 * cliAgentCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 6/6 层）。
 *
 * 承载「自主 / 编排 / 交互」类子命令：execute（replay/resume/fork/runTask）、goal、workflow、
 * routines（add|list|remove|run）、tui。方法体逐字节等价于原 exec.ts，`private`→`protected`。
 * 继承自 CliNativeCmds，为继承链倒数第二层；ExecCli 在其上承接到进程入口。
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { configFile } from '../config/configFile.js';
import { Agent } from '../core/agent.js';
import type { AgentResult } from '../core/agent.js';
import { Runtime } from '../composition/runtime.js';
import { GoalRunner } from '../autonomy/goalRunner.js';
import { GoalChecker } from '../autonomy/goalChecker.js';
import { WorkflowRunner } from '../autonomy/workflowRunner.js';
import type { WorkflowDef } from '../autonomy/workflowTypes.js';
import { SubagentPorts } from '../subagent/subagentPorts.js';
import { RoutineScheduler } from '../daemon/routineScheduler.js';
import type { Routine, RoutineSchedule, RoutineModelAdapter } from '../daemon/routineScheduler.js';
import { Interactive } from '../tui/interactive.js';
import { TuiAgentBridge } from '../tui/tuiAgentBridge.js';
import type { TuiEvent } from '../tui/tuiRenderer.js';
import { ArgParser, CliDefaults } from './argParser.js';
import { CronerSchedule } from '../adapters/schedule/cronerSchedule.js';
import type { CliArgs } from './argParser.js';
import { CliNativeCmds } from './cliNativeCmds.js';

/** 自主 / 编排 / 交互类子命令。 */
export class CliAgentCmds extends CliNativeCmds {
  /**
   * 按模式分发：replay / resume / fork / runTask。
   * @param agent 已装配运行时的 Agent 实例。
   * @param args 解析后的 CLI 参数（replayId / resumeId / forkId 决定分支）。
   * @returns 会话事件列表与结果摘要（sessionId 因模式而异）。
   */
  protected async execute(
    agent: Agent,
    args: CliArgs,
  ): Promise<{
    events: readonly import('../ports/runtime/event.js').SessionEvent[];
    summary: unknown;
  }> {
    if (args.replayId !== undefined) {
      const events = await agent.replay(args.replayId);
      return { events, summary: { sessionId: args.replayId, replayed: events.length } };
    }
    if (args.resumeId !== undefined) {
      return this.runResume(agent, args);
    }
    if (args.forkId !== undefined) {
      return this.runFork(agent, args);
    }
    return this.runNew(agent, args);
  }

  /**
   * 新会话。
   * @param agent 已装配运行时的 Agent 实例。
   * @param args 解析后的 CLI 参数（prompt 作为任务输入）。
   * @returns 会话事件列表与结果摘要。
   */
  protected async runNew(
    agent: Agent,
    args: CliArgs,
  ): Promise<{
    events: readonly import('../ports/runtime/event.js').SessionEvent[];
    summary: unknown;
  }> {
    const result = await agent.runTask(args.prompt);
    return { events: result.events, summary: this.summaryOf(result) };
  }

  /**
   * 续跑会话。
   * @param agent 已装配运行时的 Agent 实例。
   * @param args 解析后的 CLI 参数（resumeId 指定续跑的会话，prompt 为追加输入）。
   * @returns 会话事件列表与结果摘要。
   */
  protected async runResume(
    agent: Agent,
    args: CliArgs,
  ): Promise<{
    events: readonly import('../ports/runtime/event.js').SessionEvent[];
    summary: unknown;
  }> {
    const result = await agent.resume(args.resumeId!, args.prompt);
    return { events: result.events, summary: this.summaryOf(result) };
  }

  /**
   * 分叉会话。
   * @param agent 已装配运行时的 Agent 实例。
   * @param args 解析后的 CLI 参数（forkId 指定被分叉的会话，prompt 为新分支输入）。
   * @returns 会话事件列表与结果摘要（写入新会话，原会话不变）。
   */
  protected async runFork(
    agent: Agent,
    args: CliArgs,
  ): Promise<{
    events: readonly import('../ports/runtime/event.js').SessionEvent[];
    summary: unknown;
  }> {
    const result = await agent.fork(args.forkId!, args.prompt);
    return { events: result.events, summary: this.summaryOf(result) };
  }

  /**
   * 结果摘要。
   * @param result Agent 一次任务运行的结果。
   * @returns 精简摘要（sessionId / finalText / steps），供 CLI 输出。
   */
  protected summaryOf(result: AgentResult): unknown {
    return { sessionId: result.sessionId, finalText: result.finalText, steps: result.steps };
  }

  /**
   * goal：自主目标循环（#S30，对标 dsh goal/ralph）。
   * 用法: omniharness goal "<目标描述>" [--model-adapter ...] [--goal-max-iterations N]
   * @param args 子命令参数（目标描述或 --goal 旗标、--goal-max-iterations 等）。
   * @returns 进程退出码：目标描述缺失为 2，运行成功为 0。
   */
  protected async runGoal(args: readonly string[]): Promise<number> {
    const goal =
      args[0] !== undefined && !args[0].startsWith('--') ? args[0] : this.flagValue(args, '--goal');
    if (goal === undefined || goal.trim() === '') {
      process.stdout.write(
        '用法: omniharness goal "<目标描述>" [--model-adapter ...] [--goal-max-iterations N]\n',
      );
      return 2;
    }
    const maxIter = this.flagNumber(args, '--goal-max-iterations') ?? 10;
    const cliArgs = ArgParser.parseArgs(['--prompt', 'goal-placeholder', ...args]) ?? CliDefaults;
    const config = await this.buildConfig(cliArgs);
    const agent = new Agent(Runtime.createRuntime(config));
    const runner = new GoalRunner(agent, new GoalChecker(config.model), { maxIterations: maxIter });
    const result = await runner.run(goal);
    process.stdout.write(
      `${JSON.stringify({ goal: result.goal, achieved: result.achieved, iterations: result.iterations, sessionId: result.sessionId, finalText: result.finalText, reason: result.reason })}\n`,
    );
    return 0;
  }

  /**
   * workflow：DAG 工作流编排（#S31，对标 dsh agent-team / workflow DAG）。
   * 用法: omniharness workflow --file workflow.json [--resume-run <runId>] [--model-adapter ...]
   * （并发闸门见 spec 的 maxConcurrency 字段；运行日志落在 <workspace>/.omniharness/graph-runs/）
   * @param args 子命令参数（--file 指定工作流 JSON 定义；--resume-run 续跑既有运行）。
   * @returns 进程退出码：既无 --file 也无 --resume-run 为 2，文件读取/解析失败为 1，工作流失败为 1，成功为 0。
   */
  protected async runWorkflow(args: readonly string[]): Promise<number> {
    const resumeRun = this.flagValue(args, '--resume-run');
    const file = this.flagValue(args, '--file');
    if (file === undefined && resumeRun === undefined) {
      process.stdout.write(
        '用法: omniharness workflow --file workflow.json [--resume-run <runId>] [--model-adapter ...]\n',
      );
      return 2;
    }
    let def: WorkflowDef | undefined;
    if (file !== undefined) {
      try {
        def = JSON.parse(await readFile(resolve(file), 'utf8')) as WorkflowDef;
      } catch (error) {
        console.error(`工作流文件读取/解析失败: ${ArgParser.messageOf(error)}`);
        return 1;
      }
    }
    const cliArgs =
      ArgParser.parseArgs(['--prompt', 'workflow-placeholder', ...args]) ?? CliDefaults;
    const config = await this.buildConfig(cliArgs);
    const runtime = Runtime.createRuntime(config);
    // 生产入口开启运行存档（库级默认 false＝零写盘）：这是 `--resume-run` 与事后审计的前提。
    const runner = new WorkflowRunner(SubagentPorts.portsOf(runtime), { persist: true });
    try {
      // 续跑时定义从运行日志读回（`def` 可省）；同时把手上这份定义交给 runner 做一致性校验。
      const result =
        resumeRun !== undefined ? await runner.resume(resumeRun, def) : await runner.run(def!);
      process.stdout.write(
        `${JSON.stringify({
          ok: result.ok,
          runId: result.runId,
          resumed: result.resumed,
          steps: result.steps,
          blackboard: result.blackboard,
        })}\n`,
      );
      return result.ok ? 0 : 1;
    } catch (error) {
      // 规格非法 / 运行日志缺失或损坏 / 与 runId 记录不一致：fail-closed，给可读原因而非堆栈。
      console.error(`工作流执行失败: ${ArgParser.messageOf(error)}`);
      return 1;
    }
  }

  /**
   * routines add|list|remove|run：定时任务管理（D3）。
   * @param routineArgs 子命令参数（首个 token 为子动作，其余按动作解析）。
   * @returns 进程退出码：用法错误为 2，其余按动作结果为 0。
   */
  protected async runRoutines(routineArgs: readonly string[]): Promise<number> {
    // Wave A.5：注入带 IANA 时区的 cron 实现（缺省 UTC，绝不用宿主本地时区——那会让同一配置跨机器行为不同）。
    // 该端口是可选能力：注入后 cron 型任务按真实时区/DST 判定到期，interval 型与持久化语义不变。
    const scheduler = new RoutineScheduler(undefined, { cron: new CronerSchedule() });
    const sub = routineArgs[0];
    if (sub === 'list') {
      const all = scheduler.list();
      if (all.length === 0) {
        process.stdout.write('（无定时任务）\n');
        return 0;
      }
      for (const r of all) {
        const sched =
          r.schedule.kind === 'interval' ? `每 ${r.schedule.minutes} 分钟` : r.schedule.expr;
        process.stdout.write(`- ${r.name} [${r.modelAdapter}] ${sched} :: ${r.prompt}\n`);
      }
      return 0;
    }
    if (sub === 'remove') {
      const name = routineArgs[1];
      if (name === undefined) {
        process.stderr.write('用法: routines remove <name>\n');
        return 2;
      }
      const ok = scheduler.remove(name);
      process.stdout.write(ok ? `已删除 ${name}\n` : `未找到 ${name}\n`);
      return 0;
    }
    if (sub === 'add') {
      const name = this.flagValue(routineArgs, '--name');
      const prompt = this.flagValue(routineArgs, '--prompt');
      if (name === undefined || prompt === undefined) {
        process.stderr.write(
          '用法: routines add --name N --prompt P [--every Nm | --cron "*/5 * * * *"] [--model-adapter mock]\n',
        );
        return 2;
      }
      const every = this.flagValue(routineArgs, '--every');
      const cron = this.flagValue(routineArgs, '--cron');
      let schedule: RoutineSchedule;
      if (cron !== undefined) {
        schedule = { kind: 'cron', expr: cron };
      } else if (every !== undefined) {
        const minutes = Number.parseInt(every.replace(/m$/, ''), 10);
        if (Number.isNaN(minutes) || minutes < 1) {
          process.stderr.write('--every 需为正整数分钟（如 30m）\n');
          return 2;
        }
        schedule = { kind: 'interval', minutes };
      } else {
        process.stderr.write('需指定 --every Nm 或 --cron "expr"\n');
        return 2;
      }
      const modelAdapter = (this.flagValue(routineArgs, '--model-adapter') ??
        'mock') as RoutineModelAdapter;
      scheduler.add({ name, prompt, modelAdapter, schedule });
      process.stdout.write(`已添加定时任务 ${name}\n`);
      return 0;
    }
    if (sub === 'run') {
      const name = routineArgs[1];
      const now = Date.now();
      const due =
        name !== undefined
          ? scheduler.list().filter((r) => r.name === name)
          : scheduler.runDue(now);
      if (due.length === 0) {
        process.stdout.write('无到期任务\n');
        return 0;
      }
      for (const r of due) {
        process.stdout.write(`运行 ${r.name}...\n`);
        await this.runRoutineOnce(r);
        scheduler.markRun(r.name, now);
      }
      return 0;
    }
    process.stderr.write('用法: routines <add|list|remove|run>\n');
    return 2;
  }

  /**
   * 真正执行单个定时任务（复用运行时装配跑一次 Agent）。
   * @param routine 待执行的定时任务（modelAdapter 决定模型装配，prompt 作为任务输入）。
   
   * @returns 无返回值。
   */
  protected async runRoutineOnce(routine: Routine): Promise<void> {
    const args: CliArgs = {
      ...CliDefaults,
      modelAdapter: routine.modelAdapter,
      prompt: routine.prompt,
    };
    const config = await this.buildConfig(args);
    const agent = new Agent(Runtime.createRuntime(config));
    const result = await agent.runTask(routine.prompt);
    const summary = this.summaryOf(result);
    const finalText = (summary as { finalText?: string } | undefined)?.finalText ?? '';
    process.stdout.write(`${finalText.slice(0, 200)}\n`);
  }

  /**
   * 加载分层配置为默认参数（#G6：用户级 → 项目级 → profile → 环境变量，严格校验）。
   * 配置存在但非法时 loadLayered 抛 ConfigError，由调用方的 catch 统一以非零码退出（fail-closed）。
   * 归位说明：消费方仅本类（tui）与子类 ExecCli；原在 ExecCli 叶子类（本类够不着），
   * 移 cliBuildConfig 根基类又顶破上帝类红线（26 方法），故按消费方落在本层。
   * @param argv 原始命令行参数（读取 --config / --profile 显式覆盖）。
   * @returns 配置文件字段映射出的 CLI 默认值子集；找不到配置文件时使用内置默认（mock 模型）。
   */
  protected loadDefaults(argv: readonly string[]): Partial<CliArgs> | undefined {
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

  /**
   * 无第三方依赖 TUI（#S35）：交互式会话（需 TTY；非 TTY 优雅降级）。
   *
   * 2026-10-05 起接**真实任务回路**：`send` 经 `TuiAgentBridge` 跑 `Agent.runTask`/`resume`
   * （整个 TUI 会话是一个真实会话，上下文跨轮累积），会话事件经转播端口映射为渲染事件——
   * 不再是「未接模型」的回声 stub。`demo` 参数保留演示回声模式（不装配运行时）。
   * @param args 子命令参数（首参数为 demo 时进入演示回声模式；其余按 CLI 旗标解析，如 --model-adapter）。
   * @returns 进程退出码：非 TTY 或启动失败为 1，正常退出为 0，用法错误为 2。
   */
  protected async runTui(args: readonly string[]): Promise<number> {
    if (!process.stdout.isTTY) {
      process.stdout.write(
        'TUI 需要交互式终端（TTY）。非 TTY 环境下请用 omniharness chat/goal 等子命令。\n',
      );
      return 1;
    }
    if (args[0] === 'demo') {
      await Interactive.startInteractive({
        send: async function* (input: string): AsyncIterable<TuiEvent> {
          yield { kind: 'assistant', text: `收到：${input}` };
          yield { kind: 'tool_call', text: 'echo', meta: 'demo' };
          yield { kind: 'tool_result', text: input };
        },
      });
      return 0;
    }
    try {
      const defaults = this.loadDefaults(args);
      const cliArgs = ArgParser.parseArgs(['--prompt', 'tui', ...args], defaults);
      if (cliArgs === undefined) {
        ArgParser.printUsage();
        return 2;
      }
      const config = await this.buildConfig(cliArgs);
      const bridge = new TuiAgentBridge();
      const agent = new Agent(Runtime.createRuntime({ ...config, events: bridge.port() }));
      bridge.attach(agent);
      if (cliArgs.modelAdapter === 'mock') {
        process.stdout.write(
          '提示：当前模型适配器为 mock（脚本化响应）。真实对话请用 --model-adapter / --api-key 或 omniharness.json。\n',
        );
      }
      await Interactive.startInteractive({ send: (input: string) => bridge.send(input) });
      return 0;
    } catch (err) {
      console.error(`TUI 启动失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
}
