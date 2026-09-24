---
'omniharness': patch
---

**性能两节收口（审计 §2.4 / §2.5）**：repo-map 结果记忆化、消息级 token 计数缓存（带实测门槛）、SQLite 单事务写入、前端滚动帧派生缓存。**每条先实测再决定**——其中 `all()` 浅拷贝实测为可忽略，明确不修并留档。

- **repo-map 结果记忆化（§2.4）**：新增 `src/context/repoMapMemo.ts`（单槽位 memo）。
  键 = `root + 查询 + 生效旋钮指纹`（`layered/fileK/symK/rerank/prf/payloadPlan` 的**env 覆盖后**取值，
  故运行期改 env 不会命中旧键）；失效判据**另加语料实例比对**——`CorpusIndexCache` 重新索引即产出新实例，
  于是「缓存生命期严格不长于语料生命期」，比按 TTL 猜更精确；`clear()` 同步失效。
  实测（本仓真实语料）：memo 未命中 24.1 ms → 命中 **0.557 ms/次**。
- **消息级 token 计数缓存（§2.4）**：新增 `src/context/tokenCountCache.ts`（按内容字符串的**有界 LRU**，
  默认 512 条），接在 `TokenEstimator.estimate` **内部**——`ContextBreakdownEstimator` / `ContextCompactor`
  零改动受益。实测：40 步混合长度会话 **11.48 → 1.61 ms（7.13×）**；长文本命中 0.1–0.6 µs
  （重算最长 1712 µs @256 KB）。
  **关键取舍（实测驱动）**：极短文本上「查表 + LRU 续命」会**倒挂**（哈希 + 两次 Map 操作 > 直接逐码元计数），
  故设 `MIN_CACHEABLE_CHARS = 512` 门槛，短文本直接计数、不进缓存；交叉点数据表写在源码注释里可复算。
- **SQLite 写入改单事务（§2.5）**：`save` 的 `DELETE` + 逐条 `INSERT` 原各自自动提交，
  既慢又会留下半截会话。改为 `BEGIN … COMMIT`，失败 `ROLLBACK`（fail-closed：宁可留旧快照，不要半截历史）。
  实测 500 事件 **3360 ms → 16.9 ms（≈199×）**（审计原文记 8.1 ms，与本机差两个数量级，以本次实测为准并并列）。
- **前端滚动帧派生缓存（§2.5）**：新增 `web/src/ui/models/StreamModelCache.ts`（单击缓存，
  键 = `events 引用 + events.length + busy`），把「块划分 / 键 / 末条 user·assistant id / 工具调用 id 集合」
  移出**滚动帧**路径（`scrollTop` 是 state，每帧都重渲染）。实测每帧 **147 / 151 / 380 µs**
  （1000 / 3000 / 10000 事件）→ 命中 **0.1–0.3 µs**。失效判据含 `length` 以兜住「就地 push 同一数组」，
  残留边界（长度不变的就地内容修改）写在类注释里。
- **明确不修（实测为可忽略）**：`AppendOnlyEventLog.all()` 的浅拷贝实测 4.5 / 9.2 / 17.9 µs
  （1000 / 3000 / 10000 事件），每步 2–4 次 ⇒ 0.018–0.072 ms/步，比上面第一项的 24.1 ms 小三个数量级；
  改它需要把返回类型收成 `readonly` 并冻结共享快照（调用方可能就地排序/改写），**风险大于收益**，留档不修。
- **回归**：`tests/unit/tokenCountCache.test.ts`（9 例）、`tests/unit/repoMapContext.test.ts`（+4 例，
  含「旋钮不同即不同键」与早退不污染槽位）、`tests/unit/sqliteStorage.test.ts`（+2 例，
  含**写入中途失败整体回滚**）、`web/test/streamModelCache.test.mjs`（7 例）。
  web e2e 那条既有失败经回退本次 web 改动复测同样失败 ⇒ 环境性、非本轮引入。
