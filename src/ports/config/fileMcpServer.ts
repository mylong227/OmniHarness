/**
 * 配置文件里的 MCP 服务器声明。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface FileMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}
