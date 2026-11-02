import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AcpTranscriptParser } from './acpTranscriptParser.ts';
import { AuditSourceDetector } from './auditSourceDetector.ts';
import { ClaudeCodeParser } from './claudeCodeParser.ts';
import { CodexSessionParser } from './codexSessionParser.ts';
import { OmniSessionParser } from './omniSessionParser.ts';
import type { AuditLoadedSource, AuditParseResult, AuditSourceFormat } from './auditTypes.ts';

/**
 * 审计来源加载器：读文件 → 识别格式 → 交给对应解析器。
 *
 * 失败语义（全部 fail-closed，且错误文案可执行）：
 * - 文件不存在 / 是目录：读文件抛错；`expand` 负责把目录展开成文件列表；
 * - 超过 {@link AuditSourceLoader.MAX_BYTES}：拒绝读入（防把 GB 级数据当会话）；
 * - 格式认不出：**明确拒绝**，并列出支持的四种来源与 `--format` 逃生口——不猜、不产出空报告。
 */
export class AuditSourceLoader {
  /** 单文件最大字节数（64 MiB；正常会话远小于此）。 */
  public static readonly MAX_BYTES = 64 * 1024 * 1024;

  /** 目录展开的最大文件数（防误把仓库根目录传进来）。 */
  public static readonly MAX_FILES = 2000;

  /** 可识别的扩展名（目录展开时使用）。 */
  private static readonly EXTENSIONS = ['.jsonl', '.ndjson', '.json'];

  /** 格式识别器。 */
  private readonly detector: AuditSourceDetector;

  /**
   * @param detector 格式识别器（缺省新建；判据可注入替身）。
   */
  public constructor(detector: AuditSourceDetector = new AuditSourceDetector()) {
    this.detector = detector;
  }

  /**
   * 展开输入路径：目录 → 其中的会话文件（排序后，限量）；文件 → 自身。
   * @param path 输入路径。
   * @returns 文件路径列表（绝对或调用方给的相对路径）。
   * @throws Error 路径不存在、目录为空或文件数超限时抛出。
   */
  public expand(path: string): string[] {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) {
      throw new Error(`路径不存在：${path}`);
    }
    if (!stats.isDirectory()) {
      return [path];
    }
    const files = readdirSync(path, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          AuditSourceLoader.EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)),
      )
      .map((entry) => join(path, entry.name))
      .sort();
    if (files.length === 0) {
      throw new Error(
        `目录里没有可识别的会话文件（${path}；支持 ${AuditSourceLoader.EXTENSIONS.join(' / ')}）`,
      );
    }
    if (files.length > AuditSourceLoader.MAX_FILES) {
      throw new Error(
        `目录下会话文件 ${String(files.length)} 个，超过 ${String(AuditSourceLoader.MAX_FILES)} 个上限；请先按目录切分。`,
      );
    }
    return files;
  }

  /**
   * 读取并解析一个文件。
   * @param path 文件路径。
   * @param format 强制格式（缺省自动识别）。
   * @returns 解析结果与原始字节哈希。
   * @throws Error 读入失败、超限或格式认不出时抛出。
   */
  public load(path: string, format?: AuditSourceFormat): AuditLoadedSource {
    const buffer = readFileSync(path);
    if (buffer.byteLength > AuditSourceLoader.MAX_BYTES) {
      throw new Error(
        `文件 ${path} 为 ${String(buffer.byteLength)} 字节，超过 ${String(AuditSourceLoader.MAX_BYTES)} 字节上限；` +
          '审计出证只面向单次会话文件。',
      );
    }
    const text = buffer.toString('utf8');
    const resolved = format ?? this.detector.detect(text);
    if (resolved === null) {
      throw new Error(
        `无法识别 ${path} 的会话格式。支持：OmniHarness JSONL / Claude Code transcript / Codex rollout / ACP 转录。` +
          '若确认格式可用 `--source-format omni|claude-code|codex|acp` 显式指定。',
      );
    }
    const result = this.parse(resolved, text);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return { path, sha256, result };
  }

  /**
   * 按格式调用对应解析器。
   * @param format 格式。
   * @param text 文件全文。
   * @returns 解析结果。
   */
  private parse(format: AuditSourceFormat, text: string): AuditParseResult {
    switch (format) {
      case 'omni':
        return new OmniSessionParser().parse(text);
      case 'claude-code':
        return new ClaudeCodeParser().parse(text);
      case 'codex':
        return new CodexSessionParser().parse(text);
      case 'acp':
        return new AcpTranscriptParser().parse(text);
      default:
        throw new Error(`未实现的会话格式：${String(format)}`);
    }
  }
}
