# 临时目录卫生

`npm run tmp:sweep` 清理 `os.tmpdir()` 下本仓前缀且超过阈值的条目：

- `omni-chrome-*`（浏览器 profile）
- `omni-wt-*`（子代理 worktree 副本）
- `omni-ab-*` / `omni-manifest-*` / `omni-trust-*`（A/B、运行清单、信任测试夹具）
- `laya-req-*.json`（本地模型一次性请求文件）

默认 **dry-run**，只打印；确认后加 `--apply`：

```bash
npm run tmp:sweep -- --json --older-than-hours 24
npm run tmp:sweep -- --apply --older-than-hours 24
```

口径：只清本仓前缀、只清超过阈值的条目、符号链接跳过；`npm start` 会在构建后自动清一次
**超过 7 天**的条目（失败只告警，不阻断启动）。
