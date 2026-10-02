/**
 * 配置文件里的 MCP 服务器声明。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 * 2026-10-02 起支持远端 url 形态（与 command 二选一，校验见 `ConfigError.validateMcpServers`）。
 */
export interface FileMcpServer {
  readonly name: string;
  /** 本地子进程命令（stdio 形态必填；url 形态可省略）。 */
  readonly command?: string;
  readonly args?: readonly string[];
  /** 远端服务器地址（http/https；stdio 形态可省略）。 */
  readonly url?: string;
}
