---
'@mylong227/omniharness': minor
---

**audit report：脱敏旋钮 `--redact`（P3——从"能看"到"敢发"）**

- 新增 `--redact off|paths|secrets|all`（**缺省 off**，证据保真优先）：
  - `paths`：绝对路径 → **保留末两段 + 原值哈希前 8 位**的稳定标记（审阅者知道动的是哪个
    文件，看不到目录结构）；
  - `secrets`：已知密钥前缀（sk-ant-/sk-proj-/ghp_/github_pat_/xox…-/AKIA/`Bearer <token>`）+
    `*KEY,TOKEN,SECRET,PASSWORD*=` 赋值形态（**变量名保留、值替换**）+ 高熵兜底
    （长度 ≥24 且香农熵 > 4.3——十六进制哈希数学上限 4.0，git SHA 不误伤）；
  - `all` = 两者。
- **同值同标**：标记是原值规范化形态（`\`→`/`、折叠斜杠、小写）的纯函数——同一语义路径
  无论以原生 / JSON 转义 / 规范化哪种书写形态出现都是同一个标记，跨记录可交叉比对。
- 报告新增 `redaction: { mode, rules, hits }`（HTML 摘要卡 / Markdown 摘要表 / CLI 摘要行
  都显示 mode——读者一眼知道报告是否被处理过）；`verify` 对 `hits` 做**机械对账**
  （mode ≠ off 时按 records+source 里的标记数重算，改数即 `redaction` 红）。`redaction`
  摘要同时**绑定在 `integrity.head` 的封印里**（`SHA-256(链头 + 摘要)`）：删字段、把 mode
  改回 off、改 rules 都会让 `head` 红——方案 T3.2「进入哈希链、防删了痕迹」的落点；
  非脱敏报告仍是裸链头，存量报告不受影响。浏览器内嵌复核器同口径（hits + 封印）。
- 边界入文档：尽力而为的遮蔽、不是 DLP；不处理图片/二进制内嵌文本；工作区根标记可能仍
  显示末两段；`source.sha256` 始终指向原始输入文件。详见 `docs/audit/README.md` §4 第 6 条。
- 判据 +12：`auditRedactor.test.ts` 7 例（同值同标/熵阈值口径/hits 自洽/输入自带标记
  不被二次改写）+ `auditTool.test.ts` ⑨⑩⑪⑫（验收口径原文 0 命中 / 改 hits ⇒ redaction /
  CLI 用法错 2 / 删摘要或改 mode ⇒ head）+ `auditVerifierScript.test.ts` ⑧（页内复核同口径）。
