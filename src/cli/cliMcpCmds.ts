/**
 * cliMcpCmds.ts —— ExecCli 命令簇（god-class 拆分 · 第 3/6 层）。
 *
 * 承载 MCP 网关子命令：mcp serve / list / call。方法体逐字节等价于原 exec.ts，`private`→`protected`。
 * 继承自 CliServerCmds，可调用全部上游共享接线与配置装配助手。
 */

import { createInterface } from 'node:readline';
import { LineTransport } from '../server/lineTransport.js';
import { McpServer } from '../mcp/mcpServer.js';
import { McpConnector } from '../mcp/mcpConnector.js';
import { parseMcpServerSpec } from '../mcp/mcpServerCommand.js';
import { ToolGate } from '../core/toolGate.js';
import { parseArgs, messageOf } from './args.js';
import { CliServerCmds } from './cliServerCmds.js';

/** MCP 网关子命令。 */
export class CliMcpCmds extends CliServerCmds {
  /** MCP 网关子命令：serve（对外暴露）/ list（列远端工具）/ call（调远端工具）。 */
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

  /** mcp serve：以 stdio 把本地工具集暴露为 MCP 服务器（走审批 + 沙箱门禁）。 */
  protected async runMcpServe(args: readonly string[]): Promise<number> {
    const cliArgs = parseArgs(['--prompt', 'mcp-serve', ...args]);
    if (cliArgs === undefined) {
      return 2;
    }
    const config = await this.buildConfig(cliArgs);
    const transport = new LineTransport(
      (onLine) => {
        const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
        readline.on('line', onLine);
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    new McpServer({
      transport,
      tools: config.tools,
      context: { sessionId: 'mcp', workspaceRoot: cliArgs.workspace },
      gate: new ToolGate(
        config.approvals,
        config.sandbox,
        undefined,
        false,
        config.escalation,
        config.elevatedSandbox,
      ),
    });
    process.stderr.write('OmniHarness MCP 服务器已启动（stdio）\n');
    return new Promise(() => undefined);
  }

  /** mcp list：连接外部 MCP 服务器并列出其工具。 */
  protected async runMcpList(args: readonly string[]): Promise<number> {
    const spec = this.flagValue(args, '--server');
    if (spec === undefined) {
      process.stdout.write('用法: omniharness mcp list --server NAME=COMMAND\n');
      return 2;
    }
    const connection = await McpConnector.connect(parseMcpServerSpec(spec));
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

  /** mcp call：调用外部 MCP 服务器的指定工具。 */
  protected async runMcpCall(args: readonly string[]): Promise<number> {
    const spec = this.flagValue(args, '--server');
    const tool = this.flagValue(args, '--tool');
    if (spec === undefined || tool === undefined) {
      process.stdout.write(
        '用法: omniharness mcp call --server NAME=COMMAND --tool NAME [--args JSON]\n',
      );
      return 2;
    }
    const connection = await McpConnector.connect(parseMcpServerSpec(spec));
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
