# 有界队列（参考解）

导出函数：

- `createQueue(capacity)`：createQueue(capacity)：返回 { push, shift, size, isFull }；capacity 为 0 时 push 恒 false、isFull 恒 true；shift 空队列返回 undefined。
