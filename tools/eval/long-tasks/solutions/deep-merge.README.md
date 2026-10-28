# deep-merge

- `mergeDeep(a, b)`：递归合并普通对象；数组与标量由 b 覆盖。
- `getPath(obj, 'a.b.0.c')`：按点路径读取，缺失返回 undefined。
- `setPath(obj, path, value)`：返回不可变更新后的新对象（原对象不变）。
