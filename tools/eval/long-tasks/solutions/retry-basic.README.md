# 异步重试（参考解）

导出函数：

- `retryAsync(fn, attempts, delayMs?)`：retryAsync(fn, attempts, delayMs=0)：最多调用 attempts 次（attempts<=0 按 1 次）；成功返回结果；全部失败抛出最后一次错误；delayMs>0 时重试前等待。
