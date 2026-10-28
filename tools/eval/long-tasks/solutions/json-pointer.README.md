# json-pointer

- `escapePointer(token)`：`~` → `~0`、`/` → `~1`。
- `getPointer(obj, '/a/b/0/c')`：按 RFC 6901 读取；缺失返回 undefined。
- `setPointer(obj, '/a/b', value)`：返回不可变更新后的新对象。
