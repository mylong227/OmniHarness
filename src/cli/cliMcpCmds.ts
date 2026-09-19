/**
 * cliMcpCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 3/6 层）。
 *
 * 承载 MCP 网关子命令：mcp serve / list / call。方法体逐字节等价于原 exec.ts，`private`→`protected`。
 * 继承自 CliServerCmds，可调用全部上游共享接线与配置装配助手。
 */

import { McpServeRunner } from '../adapters/mcp/mcpServeRunner.js';
import { mcpConnector } from '../mcp/mcpConnector.js';
import { parseMcpServerSpec } from '../mcp/mcpServerCommand.js';
import { ToolGate } from '../core/toolGate.js';
import { parseArgs, messageOf } from './argParser.js';
import { CliServerCmds } from './cliServerCmds.js';

/** MCP 网关子命令。 */
export class CliMcpCmds extends CliServerCmds {
  /**
   * MCP 网关子命令：serve（对外暴露）/ list（列远端工具）/ call（调远端工具）。
   * @param args 子命令参数（首 token 为子动作，其余透传给对应实现）。
   * @returns 进程退出码：操作失败为 1，用法错误为 2，成功由子动作决定。
   */
  protected async runMcp(args: readonly string[]): Promise<number> {
    const sub = args[0];
    try {
      if (sub === 'serve') {
        return await this.runMcpServe(args.slice(1));
      }
      if (sub === 'list') {
        return await this.runMcpList(args.slice(1));
      }
      if (sub === 'call') {
        return await this.runMcpCall(args.slice(1));
      }
    } catch (error) {
      console.error(`MCP 操作失败: ${messageOf(error)}`);
      return 1;
    }
    process.stdout.write(
      '用法: omniharness mcp serve | mcp list --server NAME=CMD | mcp call --server NAME=CMD --tool NAME [--args JSON]\n',
    );
    return 2;
  }

  /**
   * mcp serve：以 stdio 把本地工具集暴露为 MCP 服务器（走审批 + 沙箱门禁）。
   *
   * A1 接线（2026-09-19 入口可达性审计）：**默认走官方 SDK 适配器**（`SdkMcpServerAdapter` +
   * StdioServerTransport，协议协商由官方实现托管）；SDK 不可用或起不来时回落既有手写
   * `McpServer`，回落原因由 {@link McpServeRunner} 如实打到 stderr（绝不静默）。
   * 门禁语义不因换实现而丢失：SDK 路径的工具端口经 `GatedToolPort` 前置审批 + 沙箱。
   * @param args 子命令参数（经 parseArgs 全量解析为运行时配置）。
   * @returns 永不 resolve 的 Promise（常驻 stdio 服务，直至流关闭或外部终止）。
   */
  protected async runMcpServe(args: readonly string[]): Promise<number> {
    const cliArgs = parseArgs(['--prompt', 'mcp-serve', ...args]);
    if (cliArgs === undefined) {
      return 2;
    }
    const config = await this.buildConfig(cliArgs);
    const sessionId = 'mcp';
    const context = { sessionId, workspaceRoot: cliArgs.workspace };
    const gate = new ToolGate(
      config.approvals,
      config.sandbox,
      undefined,
      false,
      config.escalation,
      config.elevatedSandbox,
    );
    // 模式选择经 stderr 如实上报（stdout 是 MCP 协议通道，不得混入提示）。
    return new McpServeRunner().run(
      {
        tools: config.tools,
        fallbackTools: config.tools,
        context,
        gate,
        fallbackGate: gate,
        serverInfo: { name: 'omniharness', version: '0.1.0' },
      },
      (result) => {
        const suffix = result.mode === 'sdk' ? result.detail : `手写回退：${result.detail}`;
        process.stderr.write(`OmniHarness MCP 服务器已启动（stdio · ${suffix}）\n`);
      },
    );
  }

  /**
   * mcp list：连接外部 MCP 服务器并列出其工具。
   * @param args 子命令参数（--server NAME=COMMAND 指定目标服务器）。
   * @returns 进程退出码：缺 --server 为 2，成功为 0（列毕即关闭连接）。
   */
  protected async runMcpList(args: readonly string[]): Promise<number> {
    const spec = this.flagValue(args, '--server');
    if (spec === undefined) {
      process.stdout.write('用法: omniharness mcp list --server NAME=COMMAND\n');
      return 2;
    }
    const connection = await mcpConnector.connect(parseMcpServerSpec(spec));
    try {
      const tools = await connection.client.listTools();
      const info = connection.info;
      process.stdout.write(
        `${info.serverInfo.name} v${info.serverInfo.version}（协议 ${info.protocolVersion}）\n`,
      );
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name}：${tool.description}\n`);
      }
      return 0;
    } finally {
      connection.close();
    }
  }

  /**
   * mcp call：调用外部 MCP 服务器的指定工具。
   * @param args 子命令参数（--server / --tool 必填，--args JSON 可选）。
   * @returns 进程退出码：缺必填项为 2，工具报错（isError）为 1，成功为 0。
   */
  protected async runMcpCall(args: readonly string[]): Promise<number> {
    const spec = this.flagValue(args, '--server');
    const tool = this.flagValue(args, '--tool');
    if (spec === undefined || tool === undefined) {
      process.stdout.write(
        '用法: omniharness mcp call --server NAME=COMMAND --tool NAME [--args JSON]\n',
      );
      return 2;
    }
    const connection = await mcpConnector.connect(parseMcpServerSpec(spec));
    try {
      const result = await connection.client.callTool(
        tool,
        this.parseJsonObject(this.flagValue(args, '--args')),
      );
      process.stdout.write(`${result.content.map((entry) => entry.text).join('\n')}\n`);
      return result.isError ? 1 : 0;
    } finally {
      connection.close();
    }
  }
}
