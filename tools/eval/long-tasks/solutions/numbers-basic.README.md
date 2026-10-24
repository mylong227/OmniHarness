# 数值基础工具（参考解）

导出函数：

- `clamp(value, min, max)`：clamp(value, min, max)：把数值夹到 [min, max] 区间。
- `percent(part, total)`：percent(part, total)：返回 part/total 的百分数并保留 1 位小数（如 1/3 -> 33.3）；total 为 0 时返回 0。
- `sumTo(n)`：sumTo(n)：返回 1..floor(n) 的和；n<1 或非有限数返回 0。
