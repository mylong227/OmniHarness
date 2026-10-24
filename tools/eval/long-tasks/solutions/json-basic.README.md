# JSON 基础工具（参考解）

导出函数：

- `safeJsonParse(text, fallback)`：safeJsonParse(text, fallback)：解析失败返回 fallback（不抛异常）。
- `flattenObject(obj, prefix?)`：flattenObject(obj)：把嵌套对象摊平成点分键（数组保持为值，不再下钻）。
- `countKeys(obj)`：countKeys(obj)：返回摊平后的叶子键数量。
