# 对象基础工具（参考解）

导出函数：

- `deepGet(obj, path, fallback)`：deepGet(obj, path, fallback)：按点分路径读取嵌套值；任一层缺失/非对象/null 时返回 fallback（值为 undefined 也回落 fallback）。
- `pick(obj, keys)`：pick(obj, keys)：只取存在的键（缺失键不写入结果）。
- `omit(obj, keys)`：omit(obj, keys)：剔除指定键（保留其余键的原始顺序）。
