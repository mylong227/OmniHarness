# 数组基础工具（参考解）

导出函数：

- `chunk(items, size)`：chunk(items, size)：按 size 切块；size 不是正整数时返回空数组。
- `uniqueBy(items, key)`：uniqueBy(items, key)：按 item[key] 去重，保留首次出现的元素与顺序。
- `flattenDeep(items)`：flattenDeep(items)：递归展开任意深度的嵌套数组（保持顺序）。
