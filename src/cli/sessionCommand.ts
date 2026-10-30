/**
 * session 子命令（SessionCommand）——列出工作区会话日志（session list）+
 * 跨机器搬运（session export / import，U3 平台互操作，2026-10-31）。
 *
 * 从原 CliDataCmds 抽出，行为逐字节等价；只依赖 CliArgReader，不依赖命令继承链，可单测。
 */

import { join } from 'node:path';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { CliArgReader } from './cliArgReader.ts';
import { SessionStorageLocation } from '../util/sessionStorageLocation.ts';
import { SessionTransfer } from './sessionTransfer.ts';
import { JsonlStorage } from '../adapters/storage/jsonlStorage.ts';
import { SessionArchive } from '../server/services/session/sessionArchive.ts';
import { log } from '../util/logger.ts';

/** session 子命令：列出工作区会话日志文件（session list），输出 id / 事件数 / 修改时间摘要。 */
export class SessionCommand {
  /**
   * 执行 session 子命令。
   * @param args 子命令参数（已去掉 `session`，首元素为子命令名）。
   * @returns 进程退出码（0 成功 / 2 用法错误 / 1 执行失败）。
   */
  public async run(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub !== 'list' && sub !== 'export' && sub !== 'import') {
      process.stdout.write(
        '用法:\n' +
          '  omniharness session list [--storage-dir DIR]\n' +
          '  omniharness session export <sessionId> [--storage-dir DIR] [--out FILE] [--format omni|claude-code]\n' +
          '  omniharness session import <FILE> [--storage-dir DIR]\n',
      );
      return 2;
    }
    if (sub === 'export') return await this.runExport(args.slice(1));
    if (sub === 'import') return await this.runImport(args.slice(1));
    // 与写入方同源（不再自己写一份 `homedir()` 拼接；见 SessionStorageLocation 的实测事故说明）。
    const dir = SessionStorageLocation.resolve(
      process.cwd(),
      new CliArgReader(args).value('--storage-dir'),
    );
    // 检查点快照不是会话（合成 id，拷贝了源会话的 session_meta 会混进列表）——与
    // sessions.list 同一份判定（SessionArchive.isSyntheticId）。
    const names = (await readdir(dir)).filter(
      (name) =>
        name.endsWith('.jsonl') && !SessionArchive.isSyntheticId(name.replace(/\.jsonl$/, '')),
    );
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
   * `session export <id> [--out FILE] [--format omni|claude-code]`：
   * 把会话事件导出为可搬运文件（omni 信封无损 / claude-code 最小文本投影）。
   * @param args 子命令参数（不含 `export`）。
   * @returns 进程退出码：缺会话 id 为 2；会话不存在或写盘失败为 1。
   */
  private async runExport(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const sessionId = reader.at(0);
    if (sessionId === undefined || sessionId.trim() === '') {
      process.stdout.write(
        '用法: omniharness session export <sessionId> [--out FILE] [--format omni|claude-code]\n',
      );
      return 2;
    }
    const format = reader.value('--format') ?? 'omni';
    if (format !== 'omni' && format !== 'claude-code') {
      process.stderr.write(`✗ 未知导出格式 "${format}"（只支持 omni / claude-code）\n`);
      return 2;
    }
    const dir = SessionStorageLocation.resolve(process.cwd(), reader.value('--storage-dir'));
    const storage = new JsonlStorage(dir);
    let envelope;
    try {
      envelope = await SessionTransfer.exportSession(storage, sessionId.trim());
    } catch (error) {
      process.stderr.write(
        `✗ 导出失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const body =
      format === 'claude-code'
        ? SessionTransfer.renderClaudeCode(envelope)
        : `${JSON.stringify(envelope, null, 2)}\n`;
    if (body.trim() === '') {
      process.stderr.write('✗ 会话没有可导出的文本事件（空会话或全为工具事件）\n');
      return 1;
    }
    const out = reader.value('--out');
    if (out !== undefined && out.trim() !== '') {
      await writeFile(out.trim(), body, 'utf8');
      process.stdout.write(`已导出 ${sessionId}（${format}）→ ${out.trim()}\n`);
    } else {
      process.stdout.write(body);
    }
    return 0;
  }

  /**
   * `session import <FILE>`：导入可搬运会话文件为**新会话**（自动识别 omni / claude-code 形态）。
   * @param args 子命令参数（不含 `import`）。
   * @returns 进程退出码：缺文件参数为 2；读文件/解析/落盘失败为 1。
   */
  private async runImport(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const file = reader.at(0);
    if (file === undefined || file.trim() === '') {
      process.stdout.write('用法: omniharness session import <FILE> [--storage-dir DIR]\n');
      return 2;
    }
    let text: string;
    try {
      text = await readFile(file.trim(), 'utf8');
    } catch (error) {
      process.stderr.write(
        `✗ 读不到导入文件：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const dir = SessionStorageLocation.resolve(process.cwd(), reader.value('--storage-dir'));
    const newSessionId = `sess_imp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    let parsed;
    try {
      parsed = SessionTransfer.parseImport(text, {
        workspace: process.cwd(),
        sessionId: newSessionId,
      });
    } catch (error) {
      process.stderr.write(
        `✗ 导入失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const storage = new JsonlStorage(dir);
    try {
      await SessionTransfer.importSession(storage, parsed.events, newSessionId);
    } catch (error) {
      process.stderr.write(
        `✗ 落盘失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    log.info('session.import.done', {
      sessionId: newSessionId,
      source: parsed.source,
      skipped: parsed.skipped,
    });
    process.stdout.write(
      `已导入 ${parsed.events.length} 个事件（来源 ${parsed.source}` +
        (parsed.skipped > 0 ? `，跳过 ${String(parsed.skipped)} 行非文本/未知行` : '') +
        `）→ 新会话 ${newSessionId}\n`,
    );
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
