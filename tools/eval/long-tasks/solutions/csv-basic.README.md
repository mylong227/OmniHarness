# CSV 基础工具（参考解）

导出函数：

- `parseCsvLine(line)`：parseCsvLine(line)：解析单行 CSV；支持双引号包裹的逗号与 "" 转义（如 a,"b,c",d -> ["a","b,c","d"]）。
- `escapeCsvField(value)`：escapeCsvField(value)：字段含逗号/双引号/换行时用双引号包裹并把内部 " 转成 ""；null/undefined 视为空串。
- `toCsvLine(fields)`：toCsvLine(fields)：逐字段 escapeCsvField 后用逗号连接。
