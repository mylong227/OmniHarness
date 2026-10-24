# 罗马数字转换（参考解）

导出函数：

- `toRoman(number)`：toRoman(number)：1..3999 的标准罗马数字；越界或非整数抛错。
- `fromRoman(text)`：fromRoman(text)：解析标准罗马数字；无法完全解析时返回 NaN。
- `isValidRoman(text)`：isValidRoman(text)：仅当能解析且 round-trip 回同一字符串时为 true（"IIII" 这类非标准写法为 false）。
