import * as readline from 'node:readline';
import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/runtime/userResponder.js';

/**
 * 交互式控制台回答器：通过 stdin/stdout 向真人提问（对标 dsh 的 UI 提问桥）。
 *
 * 仅在 TTY 环境（或由调用方显式注入）时有意义；无人值守场景请用 DefaultUserResponder。
 */
export class ConsoleUserResponder implements UserResponder {
  /**
   * 回答器标识：固定为 'console'，用于在多回答器环境区分本交互式控制台实现。
   */
  public readonly name = 'console';

  /**
   * 通过 stdin/stdout 逐题向真人提问并收集回答。
   * @param questions 待提问的结构化问题列表（含 id、问题、可选选项/多选标记）。
   * @returns 与 questions 同序的回答数组；单选下整行自由输入计入 custom，多选按编号/标签解析。
   */
  public async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answers: AskAnswer[] = [];
    try {
      for (const q of questions) {
        answers.push(await this.askOne(rl, q));
      }
    } finally {
      rl.close();
    }
    return answers;
  }

  /** 在已建好的 readline 接口上提问一题并等待用户输入。
   * @param rl 复用的 readline 接口（stdin/stdout）。
   * @param q 结构化问题（含提示头、选项列表与多选标记）。
   * @returns 本题回答（选中项或自由输入）；输入解析永不抛错。
   */
  private askOne(rl: readline.Interface, q: AskQuestion): Promise<AskAnswer> {
    return new Promise<AskAnswer>((resolve) => {
      const header = q.header !== undefined ? `[${q.header}] ` : '';
      let prompt = `${header}${q.question}\n`;
      if (q.options !== undefined && q.options.length > 0) {
        const verbs = q.multiSelect ? '可多选，输入编号（逗号分隔）' : '输入编号';
        prompt +=
          q.options
            .map(
              (o, i) =>
                `  ${i + 1}. ${o.label}${o.description !== undefined ? ` — ${o.description}` : ''}`,
            )
            .join('\n') + `\n（${verbs}）\n> `;
      } else {
        prompt += '> ';
      }
      rl.question(prompt, (raw) => {
        resolve(this.parse(q, raw.trim()));
      });
    });
  }

  /** 把用户原始输入解析为结构化回答。
   * @param q 原问题（决定选项集与单/多选语义）。
   * @param raw 用户输入（已 trim；编号、标签或自由文本，多选以逗号分隔）。
   * @returns 解析后的回答：无选项题整行计入 custom；多选下无效 token 忽略，
   *          单选下非编号且不匹配任何标签的整行计入 custom。
   */
  private parse(q: AskQuestion, raw: string): AskAnswer {
    if (q.options === undefined || q.options.length === 0) {
      return { id: q.id, selected: [], custom: raw };
    }
    const picked = new Set<string>();
    if (raw.length > 0) {
      for (const token of raw.split(',')) {
        const t = token.trim();
        if (t.length === 0) {
          continue;
        }
        const idx = Number.parseInt(t, 10);
        if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) {
          const opt = q.options[idx - 1];
          if (opt !== undefined) {
            picked.add(opt.label);
          }
        } else {
          const direct = q.options.find((o) => o.label === t);
          if (direct !== undefined) {
            picked.add(direct.label);
          } else if (!q.multiSelect) {
            // 单选下整行当作自由输入
            return { id: q.id, selected: [], custom: raw };
          }
        }
      }
    }
    return { id: q.id, selected: [...picked] };
  }
}
