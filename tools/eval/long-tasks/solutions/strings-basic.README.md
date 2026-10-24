# 字符串基础工具（参考解）

导出函数：

- `toCamel(s)`：toCamel(s)：按非字母数字分隔，首段全小写，其余段首字母大写、其余小写（如 "foo bar_baz" -> "fooBarBaz"）。
- `truncate(s, n)`：truncate(s, n)：n<=0 返回空串；长度不超过 n 原样返回；n===1 返回 "…"；否则保留前 n-1 个字符再拼 "…"。
- `countWords(s)`：countWords(s)：按连续空白切分并忽略首尾空白，空串返回 0（如 " one two\tthree " -> 3）。
