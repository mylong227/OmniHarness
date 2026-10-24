# URL 查询串工具（参考解）

导出函数：

- `parseQuery(search)`：parseQuery(search)：解析查询串（可带前导 "?"），同名键后值覆盖前值，返回普通对象。
- `buildQuery(params)`：buildQuery(params)：按对象键顺序编码为查询串（URLSearchParams 口径）；值为 undefined 的键跳过。
- `normalizePath(path)`：normalizePath(path)：合并重复斜杠、去掉末尾斜杠（根路径 "/" 保持 "/"）。
