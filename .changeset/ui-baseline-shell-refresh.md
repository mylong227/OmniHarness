---
'@mylong227/omniharness': patch
---

集成层那份**冻结 UI 结构基线**随壳层改版重写，并顺手把其中一条**已变成假绿的字段**换掉。

## 为什么它一直是红的（不是本轮引入）

第六十九/七十轮把顶栏与左竖条（`NavRail`）删掉、12 个面板入口收进右栏 `PanelPicker` 菜单，
但 `tests/integration/uiBaseline.json` 还是改版前的快照（12 个右栏页签、`railItems: 9`、
带 emoji 的空态文案、旧输入框占位）⇒ `npm run test:integration` 的 `liveUiE2e` 长期红。
**已用洁净树对照证明**与缓存分因那轮无关（`git stash --include-untracked` + 重建 src 与 web ⇒ 同样红）。

## 改了什么

1. **重写基线**（`OMNI_UI_BASELINE_UPDATE=1`）。新快照是**更强**的契约：面板入口从"数 9 个图标"
   变成**17 个入口的具名清单**（`工具/变更/文件/指标/编排/记忆/配置集/治理/回滚/钻取/设置/插件/诊断/审计/Trace/权限/凭据`）。
2. **换掉假绿字段**：`railItems` 在新壳层下**恒为 0**——按 `uiBaseline.ts` 自己立的口径
   （"采到一个永远为空的字段等于什么都没断言"），它已经是假绿。故删除该字段，改采
   `panelMenuItems`（`.pp-menu .pp-item` 的可读名）。选择器与"菜单必须由调用方展开"都写进了类型 JSDoc。
3. **采集前置条件自证**：`liveUiE2e` 现在**先用真实点击展开菜单**并断言"至少 12 个入口"，
   采完再点一次收起（并断言收起成功）——否则采到空数组会让整条判据静默退化，或让浮层挡住后面的真实点击。
4. **判据同步**：`tests/unit/uiBaseline.test.ts` 的夹具/差异断言改到新字段，并新增**选择器漂移守卫**
   （必须按 `.pp-menu .pp-item` + `.pp-label` 采集，采 `.rail` 恒为空）。

## 实跑

- `node --test dist/tests/integration/*.test.js`：**16/16 绿**（改前 15/16）。
- `tests/unit/uiBaseline.test.ts` 6 例绿；`runGates` `fast` **10/10**。
- 基线含义的更新理由（为什么"承认新壳层"是对的）写在 `uiBaseline.ts` 文件头与看板 §8.20。
