import type { ModelMessage, ModelPort } from '../ports/model.js';

/**
 * @beta
 * 目标达成判定结果。
 */
export interface GoalCheck {
  /** 是否已完全达成可验证目标。 */
  readonly achieved: boolean;
  /** 模型给出的原始判断文本（用于审计 / 调试）。 */
  readonly raw: string;
}

/**
 * @beta
 * 目标达成判定器：用模型判断「给定目标下，最近一轮产出是否已完全达成可验证目标」。
 *
 * 判据保守：仅当模型输出显式含 YES 且不含 NO 才视为达成，否则视为未达成——
 * 宁可多跑几轮，也不因模型一句含糊的「完成」提前终止（自主循环里过早停止比多花几轮更危险）。
 */
export class GoalChecker {
  public constructor(private readonly model: ModelPort) {}

  /**
   * 判定目标是否达成。
   * @param goal 目标描述
   * @param progress 最近一轮的产出/进展文本
   * @returns 达成判定（YES/NO + 模型原话）
   */
  public async check(goal: string, progress: string): Promise<GoalCheck> {
    const messages: ModelMessage[] = [
      { role: 'system', content: CHECKER_SYSTEM },
      {
        role: 'user',
        content: `目标：\n${goal}\n\n最近的进展：\n${progress || '（无产出）'}\n\n目标是否已完全达成？只回答 YES 或 NO，并附一句理由。`,
      },
    ];
    const output = await this.model.generate({ messages, tools: [] });
    const raw = (output.text ?? '').trim();
    return { achieved: parseAchieved(raw), raw };
  }
}

/** 判定系统提示：约束输出格式，强调「可验证」而非「声称完成」。 */
const CHECKER_SYSTEM =
  '你是目标达成度评审。判断给定目标是否已被最近一轮产出完全且可验证地达成。' +
  '只输出一行：YES 或 NO，其后跟一句简短理由。' +
  '除非目标被实际完成且可验证，否则回答 NO（例如仅声称完成、或只完成部分、或仍需人工确认，均判 NO）。';

/**
 * @beta
 * 从模型文本解析达成度：含独立 YES 且未被否定修饰视为达成（保守，避免过早停止）。
 */
export function parseAchieved(text: string): boolean {
  const t = text.toLowerCase();
  // 任何独立 NO 都视为未达成（no / not yet / no longer 等）。
  if (/\bno\b/.test(t)) {
    return false;
  }
  // YES 被 not / n't / 否 / 未 / 不 等否定修饰时，仍判未达成。
  const negatedYes = /(not|n't|否|未|不)\s*yes/.test(t) || /yes\s*(not|never)/.test(t);
  return /\byes\b/.test(t) && !negatedYes;
}
