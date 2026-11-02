import type { ModelMessage } from '../../contracts/ports/model/model.ts';
import { TOOL_NAMES } from '../../contracts/ports/tool/toolNames.ts';
import { log } from '../util/logger.ts';

/**
 * 压缩后**状态审计**（U2-1，2026-10-30）：摘要生成后，确定性地核对「关键工作状态是否还在」。
 *
 * ## 为什么需要它
 *
 * 压缩摘要由模型生成——它可能丢掉「改过哪些文件、跑过哪些验证命令、还有哪些待办」。
 * 工具台账（`withToolLedger`）兜住了「做过什么」，但它是**聚合去重**的（同目标 ×N 合并、
 * 上限 40 行），且预算过小时整体不加；「下一步该做什么」则完全依赖摘要的「下一步」段。
 * 此前这些丢失都是**静默**的：指标正常、不报错，长会话照着残缺摘要继续走——
 * 正是 CORE_CAPABILITY_UPGRADE §4 说的「最后一公里的静默失效」形态。
 *
 * ## 审计口径（全部确定性，无模型参与）
 *
 * 从被折叠的 head 里确定性提取四类关键状态，与**最终摘要文本（含台账）**做归一化子串比对：
 *  1. **已改文件**：`write_file` / `edit` 的 `path` ⇒ 摘要或台账须出现该路径；
 *  2. **验证命令**：`shell` 的 `command` ⇒ 须出现该命令（截断到与台账同一 80 字符口径）；
 *  3. **未完成待办**：head 内**最后一次** `todo_write` 里 pending/in_progress 项的 `content`；
 *  4. **结构段**：8 段模板的小节名须在场（缺节 ⇒ 摘要模型没按模板输出）。
 *
 * ## shadow 语义（刻意不改变行为）
 *
 * 结果**只留痕不改压缩产物**：缺失项经 `log.warn('compaction.audit.missing')` 可观测，
 * 并随 `CompactionResult.stateAudit` 上抛给上层（面板/探针可消费）；摘要文本、游标、
 * 预算组装一律不动。等有对照数据证明「缺失 ⇒ 下游失忆」的量化关系后，再决定是否升级为
 * 强制（例如重摘要一次）——现在升级就是把判断建立在噪声上。
 */
export class CompactionStateAudit {
  /** 8 段结构化摘要模板的小节名（与 `compactionSummarizer.ts` 的 SUMMARY_TEMPLATE 同源口径）。 */
  public static readonly SECTIONS: readonly string[] = [
    '任务目标',
    '关键决策',
    '涉及文件',
    '错误与修复',
    '当前进度',
    '下一步',
    '关键约束',
    '重要事实',
  ];

  /** 缺失清单上限：超过只记数，避免一条 warn 刷屏（极端 head 可有上百个文件）。 */
  private static readonly MAX_REPORTED = 8;

  /**
   * 审计一份压缩产物。
   * @param summary 最终摘要文本（应传入**已追加台账**的版本，台账也在核对范围内）。
   * @param head 被折叠的消息段（状态提取来源）。
   * @returns 审计结果：`ok` 为真表示四类状态全部在场。
   */
  public static audit(summary: string, head: readonly ModelMessage[]): CompactionStateAuditResult {
    const haystack = CompactionStateAudit.normalize(summary);
    const state = CompactionStateAudit.extractState(head);
    const missing: string[] = [];

    for (const file of state.editedFiles.slice(0, CompactionStateAudit.MAX_REPORTED)) {
      if (!haystack.includes(CompactionStateAudit.normalize(file))) {
        missing.push(`已改文件未进摘要/台账：${file}`);
      }
    }
    for (const command of state.commands.slice(0, CompactionStateAudit.MAX_REPORTED)) {
      if (!haystack.includes(CompactionStateAudit.normalize(command))) {
        missing.push(`验证命令未进摘要/台账：${command}`);
      }
    }
    for (const todo of state.openTodos.slice(0, CompactionStateAudit.MAX_REPORTED)) {
      if (!haystack.includes(CompactionStateAudit.normalize(todo))) {
        missing.push(`未完成待办未进摘要「下一步」：${todo}`);
      }
    }
    const sectionsMissing = CompactionStateAudit.SECTIONS.filter(
      (section) => !haystack.includes(CompactionStateAudit.normalize(section)),
    );
    if (sectionsMissing.length > 0) {
      missing.push(`摘要缺结构段：${sectionsMissing.join('、')}`);
    }
    return {
      ok: missing.length === 0,
      missing: missing.slice(0, CompactionStateAudit.MAX_REPORTED),
      checked: {
        editedFiles: state.editedFiles.length,
        commands: state.commands.length,
        openTodos: state.openTodos.length,
      },
    };
  }

  /**
   * 审计并留痕：缺失时 `log.warn`，通过时 `log.debug`。压缩主流程调用这个入口。
   * @param summary 最终摘要文本（含台账）。
   * @param head 被折叠的消息段。
   * @returns 审计结果（随 `CompactionResult.stateAudit` 上抛）。
   */
  public static auditAndLog(
    summary: string,
    head: readonly ModelMessage[],
  ): CompactionStateAuditResult {
    const result = CompactionStateAudit.audit(summary, head);
    if (result.ok) {
      log.debug('compaction.audit.ok', { checked: result.checked });
    } else {
      log.warn('compaction.audit.missing', {
        checked: result.checked,
        missing: result.missing,
      });
    }
    return result;
  }

  /**
   * 从被折叠的 head 里确定性提取关键工作状态。
   * @param head 消息段。
   * @returns 四类状态（文件/命令/待办）。
   */
  public static extractState(head: readonly ModelMessage[]): CompactionHeadState {
    const editedFiles: string[] = [];
    const commands: string[] = [];
    let openTodos: string[] = [];
    for (const message of head) {
      if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
      for (const call of message.toolCalls) {
        if (call.name === TOOL_NAMES.writeFile || call.name === TOOL_NAMES.edit) {
          const path = call.arguments['path'];
          if (typeof path === 'string' && path.trim() !== '') {
            editedFiles.push(path);
          }
        } else if (call.name === TOOL_NAMES.shell) {
          const command = call.arguments['command'];
          if (typeof command === 'string' && command.trim() !== '') {
            commands.push(CompactionStateAudit.oneLine(command));
          }
        } else if (call.name === TOOL_NAMES.todoWrite) {
          // last-write-wins：只看 head 内最后一次全量替换。
          openTodos = CompactionStateAudit.openTodosOf(call.arguments);
        }
      }
    }
    return {
      editedFiles: [...new Set(editedFiles)],
      commands: [...new Set(commands)],
      openTodos,
    };
  }

  /**
   * 从 `todo_write` 参数里取未完成项的描述。
   * @param args 工具参数。
   * @returns pending/in_progress 项的 content（截到 80 字符）。
   */
  private static openTodosOf(args: Record<string, unknown>): string[] {
    const todos = args['todos'];
    if (!Array.isArray(todos)) return [];
    const open: string[] = [];
    for (const item of todos) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (record['status'] !== 'pending' && record['status'] !== 'in_progress') continue;
      const content = record['content'];
      if (typeof content === 'string' && content.trim() !== '') {
        open.push(CompactionStateAudit.oneLine(content));
      }
    }
    return open;
  }

  /** 压成单行并截断（与台账 80 字符口径一致，避免「超长命令天然比对不上」）。
   * @param raw 原始文本。
   * @returns 单行、超 80 字符截断的文本。
   */
  private static oneLine(raw: string): string {
    const oneLine = raw.replace(/\s+/gu, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  }

  /**
   * 归一化：Windows 路径分隔符统一、大小写折叠、空白折叠。
   * 比对两端都过同一函数 ⇒ 摘要里写 `src\foo.ts` 或 `SRC/FOO.TS` 都能命中。
   * @param text 原文。
   * @returns 归一化文本。
   */
  private static normalize(text: string): string {
    return text.replace(/\\/gu, '/').replace(/\s+/gu, ' ').toLowerCase();
  }
}

/** 审计结果：`missing` 为空即通过（shadow 语义：只上报，不改行为）。 */
export interface CompactionStateAuditResult {
  /** 四类关键状态是否全部在场。 */
  readonly ok: boolean;
  /** 缺失项（可读描述，封顶 8 条）。 */
  readonly missing: readonly string[];
  /** 各类被核对的状态条数（用于判断「审计是否真有输入」）。 */
  readonly checked: {
    readonly editedFiles: number;
    readonly commands: number;
    readonly openTodos: number;
  };
}

/** 从 head 里提取出的关键工作状态。 */
export interface CompactionHeadState {
  /** 已改文件路径（去重，保持首现顺序）。 */
  readonly editedFiles: readonly string[];
  /** 执行过的命令（去重，单行截断）。 */
  readonly commands: readonly string[];
  /** 最后一次 todo_write 的未完成项描述。 */
  readonly openTodos: readonly string[];
}
