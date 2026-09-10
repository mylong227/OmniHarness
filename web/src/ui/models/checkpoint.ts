// 检查点领域模型：命名与时间格式化的纯逻辑。
// 零 React 依赖（可直接在 node 中单测），供回滚面板等 UI 复用。

/** 检查点元信息（与后端 checkpoint.list 返回结构对齐）。 */
export interface CheckpointMeta {
  label: string;
  ts: string;
  eventCount: number;
  hasFileSnapshot: boolean;
}

/** 检查点命名器：用户输入留空时生成时间戳名。 */
export class CheckpointNamer {
  /** 自动命名：`checkpoint-YYYY-MM-DD-HH-MM-SS`。 */
  public static auto(now: Date = new Date()): string {
    return `checkpoint-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  }

  /** 解析最终名称：有输入用输入，否则自动生成。 */
  public static resolve(input: string, now: Date = new Date()): string {
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : CheckpointNamer.auto(now);
  }
}

/** 时间展示格式化：非法时间原样返回（fail-closed 到可见原文，而不是抛错）。 */
export class TimestampFormatter {
  public static format(ts: string, locale = 'zh-CN'): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString(locale, { hour12: false });
  }
}
