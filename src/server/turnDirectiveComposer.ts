import type { SessionModes } from './sessionModeStore.js';

/**
 * 回合前置指令合成器：把 UI 的会话模式（目标 / 计划模式 / 绘图模式）翻成一段
 * 追加在用户输入**之前**的显式指令。
 *
 * 为什么要「前置指令」而不是改系统提示词：系统提示词是常驻且被缓存的部分，
 * 为一次任务的临时意图去改它，会让提示缓存整体失效（prefix 变了）；
 * 而前置指令只影响本回合的用户消息，代价小、也天然随用户原文一起进对话历史，
 * 用户回看会话时能看清「当时是按什么模式跑的」。
 *
 * 措辞纪律：指令里只描述**用户要什么**与**边界**，不替模型编造步骤与结论，
 * 也不假称这是系统权限设置——权限由审批层独立把关，提示词层面不得暗示「已获授权」。
 */
export class TurnDirectiveComposer {
  /**
   * 合成最终提示词。
   *
   * @param prompt 用户原始输入（可为空——仅附件 + 模式的回合合法）
   * @param modes 本会话模式
   * @returns 原样返回 prompt（无模式时）或「模式指令 + 原文」
   */
  public compose(prompt: string, modes: SessionModes): string {
    const blocks = this.blocks(modes);
    if (blocks.length === 0) return prompt;
    const body = prompt.trim() === '' ? '（本轮未附文字说明，请按下方模式要求推进）' : prompt;
    return blocks.join('\n') + '\n\n' + body;
  }

  /**
   * 逐项生成模式指令块（顺序固定：目标 → 计划 → 绘图，保证提示前缀稳定可缓存）。
   * @param modes 本会话模式
   * @returns 生效模式的指令块列表（未启用任何模式时为空数组）
   */
  private blocks(modes: SessionModes): string[] {
    const out: string[] = [];
    if (modes.goal.trim() !== '') {
      out.push(
        '【本会话目标】' +
          modes.goal.trim() +
          '\n该目标在后续每轮都会重申；每轮结束时给出「已完成 / 未完成 / 阻塞点」，不要提前宣告达成。',
      );
    }
    if (modes.planMode) {
      out.push(
        '【计划模式】先产出可执行的步骤方案（含涉及文件与验证方式）并停下来等确认；' +
          '本轮不要修改任何文件、不要执行有副作用的命令——写类操作会被审批层直接拒绝。',
      );
    }
    if (modes.sketchMode) {
      out.push(
        '【绘图模式】动手前先用 Mermaid（结构/流程/时序）画清方案草图，再调用 sketch_write 保存草图，' +
          '然后基于草图实现；实现完成后回头核对草图与实际是否一致，不一致要说明差异原因。',
      );
    }
    return out;
  }
}
