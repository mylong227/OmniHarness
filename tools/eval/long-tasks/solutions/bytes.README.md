# bytes

- `formatBytes(bytes)`：人类可读（B 取整，KB+ 一位小数）。
- `parseBytes('1.5 KB')`：解析回字节数；非法抛错。
- `isValidBytes(text)`：是否匹配 `数字 + 单位` 形式。
