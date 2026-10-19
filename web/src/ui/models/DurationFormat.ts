// 时长格式化（纯函数，零 React）：全站的「消耗时长 / 计时」只有这一种口径。
//
// 为什么单独成模型：思考计时、工作状态条、回合结果卡都要显示时长。此前每处各写一份
// 「分钟 + 秒」，超过 1 小时会退化成「75分3秒」并一直累加秒；用户要求换算成
// **小时 / 分钟 / 秒**。把口径收在一处，三处显示不会漂移。
//
// 输出形态（中文原文按键，en 词条负责翻译）：
//   0 秒 → 0秒；59 秒 → 59秒；61 秒 → 1分1秒；3600 秒 → 1小时0分0秒；
//   3665 秒 → 1小时1分5秒。超过 1 小时后保留「小时 + 分钟 + 秒」三段，
//   避免出现「1小时5秒」这种省略分钟、读起来像 5 秒的歧义。

import { t } from '../i18n/i18n.ts';

/**
 * 秒数 → 人类可读时长。
 *
 * 非有限值 / 负数按 0 处理；小数向下取整（计时器按整秒跳动，不四舍五入跳变）。
 * @param totalSec 总秒数
 * @returns 如 `0秒` / `1分5秒` / `2小时3分4秒`
 */
export function formatDuration(totalSec: number): string {
  const sec = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return t('{h}小时{m}分{s}秒', { h, m, s });
  if (m > 0) return t('{m}分{s}秒', { m, s });
  return t('{s}秒', { s });
}

/**
 * 毫秒 → 人类可读时长（四舍五入到整秒）。
 * @param totalMs 总毫秒数
 * @returns 如 `1分5秒`
 */
export function formatDurationMs(totalMs: number): string {
  const sec = Number.isFinite(totalMs) ? Math.round(totalMs / 1000) : 0;
  return formatDuration(sec);
}
