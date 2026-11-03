---
'@mylong227/omniharness': minor
---

**audit report：未识别条目可见化 + `--strict`**（P0 裂缝清零）

- 四个会话解析器（OmniHarness / Claude Code / Codex / ACP）统计**未识别条目**（坏行、非对象行、
  类型缺失或未知、ACP 非法帧——原来全部静默丢弃）；未知类型的条目仍以 `other` 记录保留在时间线。
- 报告头新增 `coverage: { recognized, unrecognized }`，HTML 摘要卡 / Markdown 摘要表 / CLI 摘要行
  都显示「未识别 N」。
- 新增 `audit report --strict`：任一输入未识别 > 0 ⇒ 退出码 1（报告仍生成——先留证据再报失败）。
- `audit verify` 新增 `summary` / `coverage` 两种自洽对账：摘要与覆盖率里声明"等于记录数"的数字
  必须真的等于（JSON 形态无文件自指纹，这是对账头字段被改的唯一机械防线）。
- 信任模型正式化：`docs/audit/ATTESTATION.md`（三列表：完整性 / 来源 / 时间）；
  退出码契约成文：`docs/audit/EXIT_CODES.md`；源码注释里的 docs 引用纳入死链门禁（src-mention）。
