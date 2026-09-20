---
'omniharness': minor
---

前端五项收口（性能 / 键盘 / 评审 / 可访问性 / 视觉基线）——先审计再动手，键盘与命令面板经真机确认已达标故未重复造。

**长会话性能与稳定性**

- 事件流虚拟化（可视窗口 + 上下 overscan 8 + 占位高度），贴底改为「此前在底部才贴底」（上滚查看历史不再被拽回）。
- `StreamThrottle` 把 `thread.text_delta` 压到 ≤1 次/50ms，并在 `SessionController` 真正接线（`flushStream()` 由回合收尾在定稿 `streamText` 之前调用，保证零丢字）。
- 实测：400/800 条事件都只渲染 16 块、vnode 节点 37（与总条数不成正比）；2000 次 delta → 41 次刷新（降 98.0%），flush 后逐字节一致。

**评审体验**

- 变更页键盘评审：j/k 移动、a 接受、r 拒绝、c 评论、? 帮助（打字语境不响应）。
- 检查点时间线：按天分组 + 相对时间 + `含文件快照/仅对话` 徽标 + 最新标记。
- 会话搜索接 `search.all`：分组、命中高亮、↑↓/Enter、220ms 防抖 + 乱序丢弃、确定性排序。
- 顺带拆薄两个臃肿组件（ChangesTab 420→370、SessionPanel 457→276 实现行）。

**可访问性与自适应**

- 右栏页签补 WAI-ARIA Tabs（tablist/tab/aria-selected/roving tabindex + 方向键）；FileModal 补 dialog 语义；纯图标按钮补 `aria-label`；流式卡补粗粒度 `aria-live` 播报。
- 全库补 `:focus-visible` 焦点环（原先 `outline:none` 会吃掉默认环）。
- CSS 层收敛窄窗溢出；真机实测 640px（三种抽屉态）与 1280px 全部无横向溢出。

**视觉基线（新增机制）**

- 不做像素 diff（字体/缩放差异必然假红），改**结构快照**：页签、图标栏条目数、输入区文案与控件无障碍名、空态文案；`OMNI_UI_BASELINE_UPDATE=1` 重写基线。含一条「采集选择器」契约测试，防选择器漂移导致采到空数组却永远绿。

**修掉的三处真缺陷**

1. 窄屏「回滚」面板不可达（`rollback` 缺失于右栏 TABS，而 `.rail` 在 <880px 隐藏）。
2. `responsiveProbe.mjs` 两处语法错误（CDP evaluate 裸对象字面量、Node 侧变量未插值）⇒ 探针此前跑不到测量阶段。
3. 节流导致 `web/test/e2e.test.mjs` 的「push 后立刻合并」断言失效 ⇒ 改为有界等待（1200ms），契约从「立刻」变「短时间内」，真丢字仍红。

**验证**：`web:test` 223/223；`test:integration` 11/11；全量单测与覆盖率门禁 exit 0（行覆盖 100%）；`lint` 0 告警；`check --strict` 零违规；`arch:gate` 0 违规；`audit:config-wiring` 全绿；`format:check` 通过；真机 640/1280 无横向溢出。
