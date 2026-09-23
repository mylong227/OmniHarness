/**
 * session 子命令（SessionCommand）——列出工作区会话日志（session list）。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价；只依赖 CliArgReader，不依赖命令继承链，可单测。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { CliArgReader } from './cliArgReader.js';

/** session 子命令：列出工作区会话日志文件（session list），输出 id / 事件数 / 修改时间摘要。 */
export class SessionCommand {
  /**
   * 执行 session 子命令。
   * @param args 子命令参数（已去掉 `session`，首元素为子命令名）。
   * @returns 进程退出码（0 成功 / 2 用法错误）。
   */
  public async run(args: readonly string[]): Promise<number> {
    if (args[0] !== 'list') {
      process.stdout.write('用法: omniharness session list [--storage-dir DIR]\n');
      return 2;
    }
    const dir =
      new CliArgReader(args).value('--storage-dir') ?? join(homedir(), '.omniharness', 'sessions');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    if (names.length === 0) {
      process.stdout.write('（无会话文件）\n');
      return 0;
    }
    for (const name of names) {
      await this.describe(join(dir, name), name);
    }
    return 0;
  }

  /**
   * 输出单个会话文件的摘要行（会话 id / 事件数 / 修改时间）。
   * @param file 会话文件绝对路径。
   * @param name 文件名（会话 id 兜底用）。
   
   * @returns 无返回值。
   */
  private async describe(file: string, name: string): Promise<void> {
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    const first =
      lines[0] === undefined ? undefined : (JSON.parse(lines[0]) as { sessionId?: string });
    const sessionId = first?.sessionId ?? name.replace('.jsonl', '');
    const info = await stat(file);
    process.stdout.write(`${sessionId}\t${lines.length} 事件\t${info.mtime.toISOString()}\n`);
  }
}
