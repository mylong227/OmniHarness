/**
 * cliNativeCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 5/6 层）。
 *
 * 承载「原生内核 / LSP」类子命令：native info|ping|tools|approval|session-submit|context|tool-call|bench、
 * lsp definition|references|hover|status。方法体逐字节等价于原 exec.ts，`private`→`protected`。
 * 继承自 CliCompareCmds（间接继承 CliDataCmds 全部数据/存储/插件子命令）。
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { NativeKernel } from '../native/nativeKernel.js';
import { RuleApproval } from '../adapters/approval/ruleApproval.js';
import type { LspPort } from '../ports/tool/lsp.js';
import { ArgParser, CliDefaults } from './argParser.js';
import { CliCompareCmds } from './cliCompareCmds.js';

/** 原生内核 / LSP 类子命令。 */
export class CliNativeCmds extends CliCompareCmds {
  /**
   * native：FFI 下沉（#65）——Node 进程内直调 Rust 内核（N-API / .node）。
   * 用法: omniharness native info|ping|tools|approval|session-submit|context|tool-call|bench
   * @param args 子命令参数（首 token 为子动作，其余按动作解析 --name/--args 等）。
   * @returns 进程退出码：操作失败为 1，用法错误为 2，成功为 0。
   */
  protected async runNative(args: readonly string[]): Promise<number> {
    const sub = args[0];
    try {
      const kernel = new NativeKernel();
      if (sub === 'info') {
        return this.runNativeInfo(kernel);
      }
      if (sub === 'ping') {
        const r = kernel.ping();
        process.stdout.write(`${JSON.stringify(r)}\n`);
        return 0;
      }
      if (sub === 'tools') {
        const tools = kernel.toolsList();
        for (const tool of tools as Array<{ name?: string; description?: string }>) {
          process.stdout.write(`${tool.name ?? '?'}\t${tool.description ?? ''}\n`);
        }
        return 0;
      }
      if (sub === 'approval') {
        const name = this.flagValue(args, '--name') ?? args[1];
        const argsJson = this.flagValue(args, '--args') ?? '{}';
        if (name === undefined) {
          throw new Error('native approval 需要 --name NAME [--args JSON]');
        }
        const decision = kernel.approvalCheck(
          name,
          JSON.parse(argsJson) as Record<string, unknown>,
        );
        process.stdout.write(`${JSON.stringify(decision)}\n`);
        return 0;
      }
      if (sub === 'session-submit') {
        const submission = JSON.parse(
          this.flagValue(args, '--submission') ?? args[1] ?? '{}',
        ) as unknown;
        const ops = kernel.sessionSubmit(submission);
        process.stdout.write(`${JSON.stringify(ops)}\n`);
        return 0;
      }
      if (sub === 'context') {
        const r = kernel.contextRender();
        process.stdout.write(`${JSON.stringify(r)}\n`);
        return 0;
      }
      if (sub === 'tool-call') {
        const name = this.flagValue(args, '--name') ?? args[1];
        const argsJson = this.flagValue(args, '--args') ?? '{}';
        const callId = this.flagValue(args, '--call-id') ?? 't1';
        if (name === undefined) {
          throw new Error('native tool-call 需要 --name NAME [--args JSON] [--call-id ID]');
        }
        const r = kernel.toolCall(name, JSON.parse(argsJson) as Record<string, unknown>, callId);
        process.stdout.write(
          `${JSON.stringify({ output: r.output, wrapped: r.wrapped, rejected: r.rejected })}\n`,
        );
        return 0;
      }
      if (sub === 'bench') {
        const kind = this.flagValue(args, '--kind') ?? 'approval';
        const iterations = Number(
          this.flagValue(args, '--iterations') ?? args[1] ?? (kind === 'shell' ? '20' : '5000'),
        );
        if (kind === 'shell') {
          return this.runNativeBenchShell(kernel, iterations);
        }
        return this.runNativeBench(kernel, iterations);
      }
    } catch (error) {
      console.error(`原生内核操作失败: ${ArgParser.messageOf(error)}`);
      return 1;
    }
    process.stdout.write(
      '用法: omniharness native info|ping|tools|approval --name N [--args JSON] | session-submit --submission JSON | context | tool-call --name N [--args JSON] [--call-id ID] | bench [--iterations N]\n',
    );
    return 2;
  }

  /**
   * native info：插件加载状态（可用性 + 路径）。
   * @param kernel 已构造的原生内核实例。
   * @returns 进程退出码：内核可用为 0，不可用为 1。
   */
  protected runNativeInfo(kernel: NativeKernel): number {
    process.stdout.write(
      `${JSON.stringify({ available: kernel.available(), modulePath: kernel.modulePath() })}\n`,
    );
    return kernel.available() ? 0 : 1;
  }

  /**
   * native bench：approval.check 热路径 native vs JS 对比（FFI 下沉收益度量）。
   * @param kernel 已构造的原生内核实例（不可用时抛错）。
   * @param iterations 基准循环次数。
   * @returns 进程退出码（恒为 0）；结果 JSON 打到 stdout（含每操作纳秒与 speedup）。
   */
  protected runNativeBench(kernel: NativeKernel, iterations: number): number {
    if (!kernel.available()) {
      throw new Error('原生内核不可用，无法基准（请先 npm run native:build）');
    }
    const jsEngine = new RuleApproval({ rules: [] });
    const req = { sessionId: 'bench', toolName: 'shell.run', target: 'echo hi' };
    const args = { command: 'echo hi' } as Record<string, unknown>;

    const jsStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      void jsEngine.decide(req);
    }
    const jsNs = Number(process.hrtime.bigint() - jsStart);

    const nativeStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      kernel.approvalCheck('shell.run', args);
    }
    const nativeNs = Number(process.hrtime.bigint() - nativeStart);

    const jsPerOp = jsNs / iterations;
    const nativePerOp = nativeNs / iterations;
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: 'approval',
          iterations,
          jsNsPerOp: Math.round(jsPerOp),
          nativeNsPerOp: Math.round(nativePerOp),
          speedup: Number((jsPerOp / nativePerOp).toFixed(2)),
          note: '对琐碎纯逻辑裁决，JS V8 快于 N-API 边界往返——FFI 价值在系统 API 能力与重操作，勿对微调用使用',
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  /**
   * native bench --kind shell：OS 沙箱命令执行 native in-process vs TS 子进程（旧方式）。
   * @param kernel 已构造的原生内核实例（不可用时抛错）。
   * @param iterations 基准循环次数。
   * @returns 进程退出码（恒为 0）；结果 JSON 打到 stdout；找不到 omni-cli 二进制时抛错。
   */
  protected runNativeBenchShell(kernel: NativeKernel, iterations: number): number {
    if (!kernel.available()) {
      throw new Error('原生内核不可用，无法基准（请先 npm run native:build）');
    }
    const command = 'echo bench-ffi';
    const omniCli = this.findOmniCli();

    // native in-process（N-API 直调，Rust 内核内 spawn 受限进程）
    const nativeStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      kernel.toolCall('shell.run', { command }, `b${i}`);
    }
    const nativeNs = Number(process.hrtime.bigint() - nativeStart);

    // 旧方式：TS 直接 spawn omni-cli sandbox run（每调用一个子进程）
    const subStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      execFileSync(omniCli, ['sandbox', 'run', '--command', command], { stdio: 'ignore' });
    }
    const subNs = Number(process.hrtime.bigint() - subStart);

    const nativePerOp = nativeNs / iterations;
    const subPerOp = subNs / iterations;
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: 'shell',
          iterations,
          subprocessMsPerOp: Number((subPerOp / 1e6).toFixed(3)),
          nativeMsPerOp: Number((nativePerOp / 1e6).toFixed(3)),
          speedup: Number((subPerOp / nativePerOp).toFixed(2)),
          omniCli,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  /**
   * lsp：代码导航（#S32，对标 codex LSP stdio 桥接）。
   * 用法: omniharness lsp <definition|references|hover|status> --file PATH --line N --col N [--lsp "server cmd"]
   * 语言服务器由用户自备（零依赖铁律下不内嵌），用 --lsp "cmd args" 指定（如 --lsp "typescript-language-server --stdio"）。
   * @param args 子命令参数（首 token 为子动作，--file/--line/--col 定位，--lsp 指定服务器启动命令）。
   * @returns 进程退出码：用法错误为 2，LSP 未配置或调用失败为 1，成功为 0。
   */
  protected async runLsp(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub !== 'definition' && sub !== 'references' && sub !== 'hover' && sub !== 'status') {
      process.stdout.write(
        '用法: omniharness lsp <definition|references|hover|status> --file PATH --line N --col N [--lsp "server cmd"]\n',
      );
      return 2;
    }
    const cliArgs = ArgParser.parseArgs(['--prompt', 'lsp-placeholder', ...args]) ?? CliDefaults;
    const config = await this.buildConfig(cliArgs);
    if (config.lsp === undefined) {
      process.stdout.write(
        'LSP 未配置：用 --lsp "server cmd" 指定语言服务器（如 --lsp "typescript-language-server --stdio"）\n',
      );
      return 1;
    }
    const lsp: LspPort = config.lsp;
    if (sub === 'status') {
      process.stdout.write(`${JSON.stringify({ ok: true, name: lsp.name })}\n`);
      return 0;
    }
    const file = this.flagValue(args, '--file');
    const line = this.flagNumber(args, '--line');
    const col = this.flagNumber(args, '--col');
    if (file === undefined || line === undefined || col === undefined) {
      process.stdout.write(
        '用法: omniharness lsp <definition|references|hover> --file PATH --line N --col N [--lsp "server cmd"]\n',
      );
      return 2;
    }
    try {
      if (sub === 'definition') {
        const locations = await lsp.definition(file, line, col);
        process.stdout.write(`${JSON.stringify({ ok: true, locations })}\n`);
      } else if (sub === 'references') {
        const locations = await lsp.references(file, line, col);
        process.stdout.write(`${JSON.stringify({ ok: true, locations })}\n`);
      } else {
        const doc = await lsp.hover(file, line, col);
        process.stdout.write(`${JSON.stringify({ ok: true, doc: doc ?? null })}\n`);
      }
      return 0;
    } catch (error) {
      console.error(`LSP 调用失败: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      await lsp.shutdown();
    }
  }

  /**
   * 定位 omni-cli 可执行文件（release 优先，其次 debug；兼容 src 与 dist 两种深度）。
   * @returns omni-cli.exe 的绝对路径；两种构建均不存在时抛错。
   */
  protected findOmniCli(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [join(here, '..', '..'), join(here, '..', '..', '..')];
    for (const root of roots) {
      for (const sub of ['release', 'debug']) {
        const candidate = join(root, 'target', sub, 'omni-cli.exe');
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    throw new Error(
      '未找到 omni-cli 二进制（target/release|debug/omni-cli.exe），无法做子进程基准',
    );
  }
}
