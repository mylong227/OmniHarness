# 日期与时长工具（参考解）

导出函数：

- `isLeapYear(year)`：isLeapYear(year)：闰年规则（能被 4 整除且不能被 100 整除，或能被 400 整除）。
- `daysInMonth(year, month)`：daysInMonth(year, month)：month 为 1..12（1=一月）；越界月份返回 0。
- `formatDuration(ms)`：formatDuration(ms)：把毫秒格式化为 "1h 1m 1s"（省略为 0 的靠前单位；0 毫秒输出 "0s"；负数按 0）。
