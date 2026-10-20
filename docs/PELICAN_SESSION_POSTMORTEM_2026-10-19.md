# 鹈鹕会话复盘：20 分 35 秒里发生了什么，以及怎么把它压到 6–9 分钟

> 复盘对象：`~/.omniharness/sessions/sess_mvf6q61y_e.jsonl`（工作区 `D:\work\new_work_0000001`）
> 任务：「创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画……」
> 时间：2026-10-19 20:42:33 → 21:03:09（本地），墙钟 **1235.4 秒（20 分 35 秒）**
> 产物：`pelican-bike.html`（17.6 KB）+ 7 张自查截图
> 本文所有数字均可由该 JSONL 重算；关键结论都附了复现命令或代码位置。

---

## 0. 一句话结论

**这不是模型"画得慢"，而是工具暴露把 `write_file` 藏了 5.5 分钟，随后又用了四次整文件生成
（一次被沙箱拒绝、一次落盘、两次重写）去修一个 17 KB 的文件。** 45 次模型调用里 97.9% 的时间
在等模型生成，工具执行只占 1.7%——所以优化方向不是"把工具调快"，而是**减少调用次数、减少
输出 token、别让模型每一步都重传几 MB 的截图**。

---

## 1. 事实面板

| 指标                     | 数值                                         | 说明                                                    |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------- |
| 墙钟                     | **1235.4 s**（20m35s）                       | 模型 1209.6 s（97.9%）+ 工具 20.4 s（1.7%）+ 5.4 s 调度 |
| 模型调用                 | **45 次**                                    | 44 次带工具，1 次收尾                                   |
| 工具调用                 | 45 次，**12 次失败（26.7%）**                | 首次失败 84.1 s，末次 1227.2 s                          |
| 输入 token               | 3,308,409                                    | 其中缓存命中 3,058,816（**92.5%**）                     |
| 输出 token               | 92,529                                       | 首调 20,193；四次整文件生成合计 38,596                  |
| 总 token                 | 3,400,938                                    | 产出 17.6 KB 文件                                       |
| 截图                     | 7 张，base64 合计 6,202,672 字符（≈5.9 MiB） | 会话存档 6.28 MiB                                       |
| 截图累计上传             | **86,372,500 字符 ≈ 82.4 MiB**               | 附件在之后每一步被重发；压缩后预计 ~14 MiB              |
| 会话存档                 | 6,586,484 B                                  | 占本机 150 个会话总大小（8.1 MB）的 **77%**             |
| 估算成本（flash 真价）   | **≈ $0.20**                                  | 0.30 / 1.20 / 0.006 USD per 1M                          |
| 估算成本（价目表兜底价） | ≈ $2.06                                      | `deepseek-flash` 未命中价目表，见 §6.6                  |

### 时间去哪了

| 阶段                       | 区间        | 耗时      | 有效产出                                                                    |
| -------------------------- | ----------- | --------- | --------------------------------------------------------------------------- |
| 首次设计（20k token 思考） | 0–84 s      | 84 s      | 一份完整设计稿（还没落盘）                                                  |
| **写文件失败循环**         | 84–428 s    | **344 s** | 0（6 次写文件尝试 + 1 次探测被 `node -e` 规则拒绝，另 1 次 `require` 报错） |
| `tool_search` + 首次写文件 | 428–537 s   | 109 s     | 找到 `write_file`，落盘 6.5k token                                          |
| 预览 + 首批截图            | 537–564 s   | 27 s      | 2 张截图                                                                    |
| 看截图 + **整文件重写 #2** | 564–811 s   | 247 s     | 12.5k token 重写                                                            |
| 补丁失败 + 缩放截图        | 811–847 s   | 36 s      | 一次 `apply_patch` 格式错误                                                 |
| 看截图 + **整文件重写 #3** | 847–1161 s  | **314 s** | 6.8k token 重写                                                             |
| 终检 + 清理 + 收尾         | 1161–1235 s | 74 s      | 最终截图、删除临时文件                                                      |

**四次「生成整份文件」的模型调用合计 880 s（14.7 分钟）**：210.8 s 那次被沙箱拒绝（纯浪费）、
108.8 s 首次落盘、246.7 s 与 313.8 s 是两次重写。一个 17.6 KB 的文件被全文生成了 4 遍。

---

## 2. 失败链（按发生顺序，附证据）

### 2.1 根因一：工具暴露把文件工具整体藏了（损失 ≈5.5 分钟）

会话第一次请求只拿到 **17 个工具**（`model` 事件 `context.tokens.systemToolCount = 17`），
里面没有 `read_file` / `write_file` / `edit` / `apply_patch` / `grep` / `glob`。
模型只能拿 `shell` 和 `run_code` 去变通。

用生产默认类别表复算：可见数 **17** 与事故一致（`systemToolCount`），且文件工具全部落在延迟集：

```
matched: [ 'exec', 'visual' ]
visible(17): agent_identity, ask_user, browser_screenshot, budget_status,
             plan_present, plan_read, plan_write, run_code, shell, shell_interactive,
             shell_job, spill_read, todo_read, todo_write, tool_search, view_image, view_media
deferred(16): apply_patch, checkpoint, edit, glob, grep, list_dir, memory_search,
              policy_eval, read_file, rollback, run_goal, run_workflow, sketch_write,
              subagent, web_fetch, write_file
```

两条错误同时发生：

1. **「创建」不在 `files` 关键词里**。任务原文是「创建**一个 HTML**……」，不含「文件 / 写 /
   编辑 / 修改 / 补丁 / 目录」，于是 `files` 类整体被延迟。
2. **「你不需要任何测试」里的「测试」命中了 `exec`**。否定语义没有被理解，反而把
   `shell` / `run_code` / `shell_job` 放进来了；「动画」又命中 `visual`。于是系统认为
   「这是个跑命令 + 看图的活」，把文件工具全藏了。

而系统提示第 2 条写的正是「新建或整文件重写用 `write_file`」——**提示让模型用一个它看不见的
工具**。模型于是走 `run_code`，在程序里 `await call('shell', { command: 'node -e ...' })`，
连续撞上沙箱的 `node -e` 危险规则。

修复位置：

- `src/core/toolExposurePlanner.ts:162` — `files` 类补入创建意向词（创建 / 新建 / 生成 /
  编写 / 写一个 / 绘制 / html / svg / css / 代码 / 源码 / 页面）。
- `src/core/stepContextBuilder.ts:162` — 把「本轮未直载的工具」写成一条系统消息，模型不必
  等到第 427 秒才想起 `tool_search`。

复算结果：同一任务 `visible 17 → 23`，`write_file` / `read_file` / `edit` / `apply_patch`
全部可见（多给 6 个工具约 600 token/步，换掉 5.5 分钟盲试）。

### 2.2 根因二：BM25 检索对中英混排查询恒空（本该兜住 2.1 的第二道防线）

规划器还有一条 BM25 检索路：类别没命中、但**描述相关**的工具会被捞回。这次它补入 **0 个**。
原因在分词：

```
旧分词("创建一个html，内容是svg绘制……")
→ ['创建一个html', '内容是svg绘制一个鹈鹕骑自行车的2d动画', '你不需要任何测试', …]
```

只有**整块是纯 CJK** 时才补二元组；`创建一个html` 这种中英混排块既拿不到 `html`，也拿不到
`创建/内容/绘制` 任何一个中文二元组。而工具描述全是中文，交集恒空——检索路等于没接线。

修复：`src/core/toolExposurePlanner.ts:581` 改为先切「ASCII 连续段 / CJK 连续段」，
再对 CJK 段补二元组。对纯 CJK / 纯 ASCII 输入与旧实现逐位一致；混排查询现在能补入
`read_file` / `write_file` / `edit` 等 3 个工具（本次复算）。

### 2.3 `node -e` 被拦，但错误只说「命中规则」

沙箱把 `node -e` 列入危险命令（`dangerous-commands.json`），这是对的；问题是拒绝文案没有
**替代动作**。模型看到的只有「命中危险命令规则: node -e」，于是换引号、换 base64、换单双引号
**又试了 6 次**（320 → 424 秒，其中 5 次是写文件、1 次是 `console.log(2+2)` 探测）。

修复：

- `src/core/toolGate.ts:322` — 对解释器内联类拒绝追加可执行建议：写文件用
  `write_file/edit/apply_patch`；跑脚本先落 `.js/.py` 再按文件名执行。
- `src/adapters/tool/code/codeExecutorTool.ts:42` — `run_code` 描述明确「没有 Node 内置模块
  （require/fs/process 不可用），落盘请 `call('write_file', …)`」，避免第一次 `require` 试错。

### 2.4 `apply_patch` 两次格式错误

- 556 s：`*** Begin Patch` 自定义头 → `patch 缺少 +++ 目标文件头`
- 847 s：`@@` 后没写行号区间 → `patch 中 pelican-bike.html 缺少有效 @@ hunk`

两次都只回错误名，模型只能再猜。修复：`src/adapters/tool/fs/applyPatchTool.ts:62` 在解析失败
时附 6 行最小可用示例（`---/+++/@@ -1,2 +1,2 @@`）。

### 2.5 重写循环：修一个局部 = 重新生成整个文件

811 s 与 1161 s 两次都是「看截图 → 发现 2–3 个问题 → `write_file` 整文件重写」。
`write_file` 一次 6.5k–12.5k token，直接对应 2–5 分钟。第一次重写后 `apply_patch` 又失败，
模型于是选择「更保险」的再重写一次——这就是 314 秒那一跳。

修复：`src/config/defaultPromptFragments.ts:127` 补一句硬规则——**迭代已有文件不要动辄整文件
重写**（一次就是数千输出 token 与数分钟；还容易把上一轮修好的细节改回去）。

### 2.6 截图附件被无限重传（成本 / 延迟 / 内存的共同主因）

7 张截图（6.2M base64 字符）不是"传一次"，而是**每一步都随上下文重传**：

- 第 24 次调用（2 张图，71.7k prompt）耗时 246.7 s / 输出 12,495 token（≈50 tok/s）
- 第 29 次调用（3 张图，90.8k prompt）耗时 313.8 s / 输出 6,777 token（≈21.6 tok/s）
- 对照：第 1 次调用（无图、5.8k prompt）84 s / 20,193 token（≈240 tok/s）

按调用累计上传 **82.4 MiB**。这就是"程序消耗"和"完成时长"最直接的杠杆：同一段生成，
prompt 里塞的图越多，上游 prefill/传输越慢。

修复（两层）：

- `src/adapters/tool/browser/browserScreenshotTool.ts:152` + `src/ports/media/imageResizer.ts:36`
  — **落盘仍是原图**，送模型的那份压到长边 1600 px、≤500 KiB 的 JPEG。真实测量（本机 sharp）：

  | 原图                                       | 压缩后                    | 倍数      |
  | ------------------------------------------ | ------------------------- | --------- |
  | `pelican-final.png` 325,829 B（1200×720）  | 51,107 B JPEG（1200×720） | **6.4×**  |
  | `pelican_zoom1.png` 795,360 B（2400×1400） | 78,808 B JPEG（1600×933） | **10.1×** |

- `src/context/contextAssembler.ts:27` — 附件预算 700k 字符（≈6–7 张压缩图，或 1 张未压缩的
  全尺寸 PNG），更旧的附件降级成一行文字并保留文件名；最新一份永远保留。事件日志不动，只改
  模型看到的投影。压缩后 7 张图合计约 0.67M 字符，**整段会话都能保留**；累计上传从 82.4 MiB
  降到约 **14 MiB（≈6 倍）**。若 sharp 不可用（精简安装），淘汰层仍把历史附件压到 ≤0.7M
  字符（最新一张无条件保留，单张约 1.06M 字符）。

### 2.7 headless Chromium 从不关闭（内存泄漏）

`BrowserScreenshotTool.close()` 存在，但**全仓没有任何调用点**（`grep 'screenshotTool.close'`
为空）。截图一次后，Chrome 会常驻到进程退出，通常 150–300 MB。

修复：`src/adapters/tool/browser/browserScreenshotTool.ts:142` — 最后一次调用后空闲 3 分钟
自动 `close()`；定时器 `unref()`，不拖住 CLI 退出。连续截图仍复用同一浏览器。

### 2.8 其它确诊但本轮未改的问题

| 问题                            | 证据                                                                          | 影响                                        |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| **repo-map 每步注入**           | 模型 6 次在 reasoning 里写「The repo map is unrelated — ignore」              | 每步约 1.5k token，还稀释注意力             |
| **`turn_diff` 漏掉 shell 删除** | 1219 s `del _preview_server.js` 成功，但 1235 s 的 `turn_diff` 仍把它列为新建 | 回滚/变更面板与实际工作区不一致             |
| **未定价模型按兜底价计费**      | 会话模型 `deepseek-flash` 不匹配价目表任何键（只有 `deepseek-v4-flash`）      | 成本估算 ≈$2.06，实际 ≈$0.20，**10 倍高估** |
| **会话存档内联 base64**         | 单个 20 分钟会话 6.28 MiB，占全部 150 个会话的 77%                            | 列表扫描/回放反复整文件读                   |
| **会话摘要整文件读**            | `sessionScanCache.parseSummary` 用 `readFile` 后 `split('\n')`                | 存档一变就重读 6.3 MB                       |
| **图片 token 不入账**           | 末次调用 provider 报 107,633 prompt token，本地 `usedTokens` 83,146           | 压缩阈值按 83k 判断，实际可能先撞窗口       |
| **`del /q` 过宽**               | 1215 s 清理命令被拒（`del /q` 规则命中），模型改 `del` 重试                   | 多一次往返（小）                            |

---

## 3. 准确度复盘：为什么最后那只翅膀还是一根"白管子"

最终渲染（`D:\work\new_work_0000001\.omniharness\screenshots\pelican-final.png`）整体可读：
天空/云/山/公路/车轮/车架/曲柄/腿的 IK 都在，鹈鹕的头、喙、喉囊、围巾也成立。但有三处硬伤：

1. **近侧翅膀**从肩部到车把是一根几乎等宽的白色带子，末端一个圆头——读起来像"第二根脖子"或
   象鼻，而不是翅膀。模型在 811 s 的 reasoning 里**自己已经指出**「double neck / white sausage」，
   但 1161 s 的"修法"只是换了一条填充路径，宽度和羽毛分层没有本质变化。
2. **围巾**是一根直杆 + 尖头，不是飘带（JS 每帧生成 ribbon，但振幅/相位在那个瞬间接近直线）。
3. **只有一条腿清晰可见**，远侧腿被车架吃掉；髋点与身体的连接也偏"贴"。

为什么改不动：

- **每次迭代 4–5 分钟**，20 分钟只够 3 次有效迭代（初版 → 重写 #2 → 重写 #3）。
- 模型**自己审查自己**：它看的是同一张图，判断标准是"looks decent"，缺少外部检查清单。
- 2400×1400 全页截图对"单根翅膀"这种局部细节并不划算：图很大、局部很小，还让每次重传更贵；
  它真正需要的是**局部裁剪高倍图**。
- 没有"改完必须逐条对照上一轮问题"的收尾约束，最终答复因此**过度声明**：
  「翅膀糊成一团……都改掉了」——但成品里那根管子还在。

准确度改进建议（未在本轮改代码，见 §6）：

- 视觉类任务收尾加一个**新鲜上下文的 critic**（subagent 拿截图 + 需求清单，只挑毛病），
  作者模型看不到自己的盲点。
- `browser_screenshot` 增加 `clip` / 局部放大参数（或规定先 `view_image` 裁切再判断），
  让"看细节"的单价从 800 KB 降到几十 KB。
- 系统提示对"视觉/创作任务"补一条：每轮只改 1–2 个具体缺陷，改完立刻截图对照，
  不允许"感觉差不多了"就收尾。

---

## 4. 消耗与内存：数字与机制

### 4.1 token 与钱

```
输入 3,308,409（缓存 3,058,816 / 未缓存 249,593）
输出    92,529
合计 3,400,938
```

按 `deepseek-v4-flash` 真价（0.30 / 1.20 / 0.006 USD per 1M）：

```
缓存输入 3.059M × 0.006 = $0.018
未缓存   0.250M × 0.30  = $0.075
输出     0.093M × 1.20  = $0.111
合计 ≈ $0.204
```

按兜底价（1.0 / 3.0 / 0.5）≈ **$2.06**。差 10 倍的原因不是用量，而是 `deepseek-flash`
这个名字不在价目表里（`routePricing.ts` 只有 `deepseek-v4-flash`），见 §6.6。

### 4.2 内存与 IO

| 项             | 实测                           | 机制                                       |
| -------------- | ------------------------------ | ------------------------------------------ |
| 存档           | 6.28 MiB / 150 个会话共 8.1 MB | 7 张截图 base64 内联在 `tool_result.files` |
| 解析该存档     | heap 11.1 MiB，RSS 62.6 MiB    | `JSON.parse` 每行 + 字符串常驻             |
| 单次请求体峰值 | ≈6.2 MB base64                 | 历史附件全量重发                           |
| 累计上传       | 82.4 MiB                       | 45 次调用 × 当时已积累的附件               |
| 浏览器进程     | 150–300 MB，常驻               | `close()` 无调用点                         |
| 会话列表扫描   | 每次变更整读 6.3 MB            | `parseSummary` 全文 `readFile` + `split`   |

注意：`TokenEstimator` 对附件只计"信封文本"（文件名/MIME），不计图片本身的视觉 token
（注释里明确说无法从 base64 推断）。这次 provider 报 107,633，本地只算 83,146——
在"截图很多"的会话里，压缩会**偏晚**触发。建议给每张图一个保守常数（如 1,600 token），
或直接用 provider 返回的 `promptTokens` 校准。

---

## 5. 本轮已落地的修复（可直接验收）

| #   | 改动                             | 文件:行                                                                                        | 预期效果                                        |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | `files` 类补创建意向词           | `src/core/toolExposurePlanner.ts:162`                                                          | 同类任务不再丢 `write_file`（17→23 个可见工具） |
| 2   | BM25 混排分词修复                | `src/core/toolExposurePlanner.ts:581`                                                          | 中文+英文查询的检索路从"恒空"恢复               |
| 3   | 未直载工具清单进上下文           | `src/core/stepContextBuilder.ts:162`                                                           | 模型第一步就知道缺什么，直接 `tool_search`      |
| 4   | 截图附件压缩（JPEG 1600/500KiB） | `src/adapters/tool/browser/browserScreenshotTool.ts:152`、`src/ports/media/imageResizer.ts:36` | 单图体积 **6–10 倍**下降，落盘原图不变          |
| 5   | 旧图片附件预算淘汰               | `src/context/contextAssembler.ts:27`                                                           | 历史附件压到 ≤700k 字符（最新一张无条件保留）   |
| 6   | 浏览器空闲 3 分钟自动关闭        | `src/adapters/tool/browser/browserScreenshotTool.ts:142`                                       | 消除常驻 Chromium 的 150–300 MB                 |
| 7   | `run_code` 明确无 Node 内置模块  | `src/adapters/tool/code/codeExecutorTool.ts:42`                                                | 少一次 `require` 试错                           |
| 8   | 沙箱拒绝附替代动作               | `src/core/toolGate.ts:322`                                                                     | `node -e` 被拒后不再换引号重试                  |
| 9   | `apply_patch` 失败附最小示例     | `src/adapters/tool/fs/applyPatchTool.ts:62`                                                    | 少一到两轮格式猜测                              |
| 10  | 提示词禁止动辄整文件重写         | `src/config/defaultPromptFragments.ts:127`                                                     | 迭代改局部，省数千输出 token/轮                 |

**验证**：`tsc --noEmit` 通过；ESLint（改动文件）通过；相关单测 **77 passed / 8 files**，
新增 4 条回归判据（创建类任务不丢文件工具、混排检索、附件预算、截图压缩）。

---

## 6. 下一步（按性价比排序，均未在本轮改）

### 6.1 把"思考预算"按任务分层（最高性价比，0 代码风险）

本次 `reasoning: max`，首调 20,193 输出 token（63k 字符思考）才落第一笔。创作/视觉类任务
`high` 通常足够；`max` 主要买"更长的自我辩论"，不买"更准的 SVG"。建议：

- 配置层允许 `reasoning: high` 作为默认，`max` 只在难题显式开启；
- 或在系统提示里对"从零创作"加一句"先落最小版本，再看图迭代"，避免一次思考把整套设计做完。

### 6.2 视觉 critic（准确度）

视觉任务收尾派生一个**新鲜上下文**的 subagent：输入 = 需求清单 + 最新截图（+ 上一轮问题清单），
输出 = 逐条"仍然存在/已修复"。主模型只负责改。成本约 5–10k token，换掉一次 4 分钟的整文件重写。

### 6.3 局部截图（准确度 + 成本）

`browser_screenshot` 增加 `clip: {x,y,width,height}`（或 `selector`），只截鹈鹕/翅膀区域。
2400×1400 全页 → 600×400 局部，payload 与视觉 token 都降一个量级，细节反而更清楚。

### 6.4 会话存档外置附件（内存）

`tool_result.files` 只存 `{name, mediaType, path}`，base64 落到
`.omniharness/attachments/<session>/<hash>`；回放/组装时按需读。收益：

- 存档从 6.28 MiB 降到几十 KB；
- 会话摘要不必整读 6.3 MB（配合 head/tail 读取）；
- 同一张图多次引用可去重。

### 6.5 `turn_diff` 覆盖 shell 删除

`turnDiffTracker` 目前只影子 `write_file/edit/apply_patch`；`del`/`rm`/`mv` 经由 shell 的
变更不会出现在 diff 里（本次 `_preview_server.js` 就是实例）。最小修法：shell 成功后对比
工作区 mtime 指纹，或让 `del/rm/mv` 走受跟踪的专用工具。

### 6.6 价目表补 `deepseek-flash`

`routePricing.ts` 只有 `deepseek-v4-flash`；会话里用的是 `deepseek-flash`，落兜底价
（1.0/3.0/0.5），把 $0.20 算成 $2.06。要么加一条别名价目，要么把
`UNPRICED_DEFAULT_FAMILIES` 的"未定价"暴露到 `budget_status`（现在会报，但没人看）。

### 6.7 否定语义（工具暴露的长期解）

「你不需要任何测试」命中 `exec` 是词法匹配的固有缺陷。低成本做法：命中关键词前检查
前 6 个字符是否含 `不要/不需要/无需/禁止/别`，命中则跳过该类。不要上模型分类器——那会把
"确定性集合属性"变成"采样"。

### 6.8 压缩阈值计入图片

给 `TokenEstimator` 的附件加保守常数（每张 1,600 token），并让 `context.usedTokens`
与 provider `promptTokens` 的差值进入观测。否则 10 张图的会话会在"本地 83k / 真实 120k"
时还以为没超。

---

## 7. 复跑验收清单

同一任务、同一模型，重跑一次，目标：

| 指标           | 本次              | 目标                               |
| -------------- | ----------------- | ---------------------------------- |
| 墙钟           | 20m35s            | **6–9 min**                        |
| 模型调用       | 45                | **10–15**                          |
| 失败工具调用   | 12                | **≤2**                             |
| 输出 token     | 92.5k             | **≤40k**                           |
| 累计图片上传   | 82.4 MiB          | **≤15 MiB**                        |
| 整文件生成次数 | 4                 | **1**（其余用 `edit/apply_patch`） |
| 最终准确度     | 翅膀/围巾仍有硬伤 | critic 清单逐条通过                |

复跑时重点看三件事：①第一步的工具表里有没有 `write_file`；②第一次截图之后有没有"整文件重写"
（有就说明提示词规则没生效）；③`tool_result.files` 的 base64 是否显著变小。

---

## 附：复现命令

```powershell
# 逐行 JSON.parse 后按事件类型统计；关键字段：
#   ev.type ∈ {session_meta,user,reasoning,model,tool_call,tool_result,assistant,turn_diff}
#   ev.payload.usage.{promptTokens,completionTokens,cachedPromptTokens}
#   ev.payload.files[].data（base64）
```

关键事实来源：

- 17 工具 / 45 调用 / 12 失败：`model` 与 `tool_result` 事件逐条统计
- 82.4 MiB：按每次 `model` 调用前已积累的 `files[].data.length` 求和
- 6.28 MiB：`sess_mvf6q61y_e.jsonl` 文件大小
- 复算工具暴露：`ToolExposurePlanner.plan({ taskText, tools })`，见 §2.1 输出
