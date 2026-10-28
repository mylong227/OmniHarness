# duration

- `formatDuration(ms)`：`0s` / `1m 30s` / `1h` / `1h 1m 1s`。
- `parseDuration('1h30m')`：解析 h/m/s 组合为毫秒；非法抛错。
- `isValidDuration(text)`：是否只含 `数字+h/m/s` 的组合。
