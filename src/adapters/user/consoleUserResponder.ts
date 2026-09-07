import * as readline from 'node:readline';
import type { AskAnswer, AskQuestion, UserResponder } from '../../ports/userResponder.js';

/**
 * 交互式控制台回答器：通过 stdin/stdout 向真人提问（对标 dsh 的 UI 提问桥）。
 *
 * 仅在 TTY 环境（或由调用方显式注入）时有意义；无人值守场景请用 DefaultUserResponder。
 */
export class ConsoleUserResponder implements UserResponder {
  readonly name = 'console';

  async ask(questions: readonly AskQuestion[]): Promise<readonly AskAnswer[]> {
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
