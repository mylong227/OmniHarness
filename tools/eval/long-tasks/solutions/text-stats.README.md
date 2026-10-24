# 文本统计工具（参考解）

导出函数：

- `slugify(text)`：slugify(text)：转小写、非字母数字压成 "-"、去掉首尾 "-"（如 "Hello, World!" -> "hello-world"）。
- `readingTime(text)`：readingTime(text)：按每分钟 200 词估算阅读分钟数，向上取整且非空文本至少 1；空文本返回 0。
- `wordFrequency(text)`：wordFrequency(text)：统计小写单词（字母/数字/撇号）出现次数，返回普通对象。
