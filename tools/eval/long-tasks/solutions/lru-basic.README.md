# LRU 缓存（参考解）

导出函数：

- `createLru(capacity)`：createLru(capacity)：返回 { get, set, size, keys }；get 命中即刷新为最近使用；超容量淘汰最久未使用；capacity<=0 时 set 为 no-op、get 返回 undefined。
