---
'omniharness': minor
---

受种技能（`skills`）从「只有编程入口」补成可用能力：配置文件 `skills` 内联数组 + `--skills <file.json>`（可重复），两条通道同一份 fail-closed 校验；并修掉沿线暴露的两处真缺陷。

**新增输入通道**

- 配置文件：`omniharness.json` 的 `skills: [{ name, description, instructions, tags? }]`（`FileConfig` + `KNOWN_KEYS` + `FIELD_VALIDATORS` 三处登记）。
- CLI：`--skills <file.json>`（可重复；文件为数组或 `{"skills": [...]}`），与内联数组合并，**同名以旗标为准**（技能注册表对重名直接抛错，故合并时显式去重）。
- 链路：`argParser.configDefaults`（file→CLI）→ `CliBuildConfig`（CLI→partial，`CliSkillFlags` 合并两条来源）→ `ConfigFactory`（`assembleSkillStack` → `SkillRegistry`）。
- 校验 fail-closed 且**带位置**：非数组 / 单项非对象 / `name|description|instructions` 缺失或全空白 / `tags` 非字符串数组 / 同源重名 / 文件读不到 / JSON 非法 —— 报错指明 `omniharness.json: skills[0].xxx` 或 `--skills <path>: ...`。
- 只收**声明式子集**（`SkillEntry = Pick<Skill,'name'|'description'|'instructions'|'tags'>`）：莫尔组合 / 相变固化等运行时字段不允许由配置注入（否则等于让配置伪造「这技能是涌现/固化来的」）。归一化结果**写回**配置（`name: " a "` 会被裁剪），避免「校验通过但 `match()` 永不命中」的静默失效。

**沿线修掉的两处真缺陷**

- **S1 受种技能从不注入**：`Agent` 的技能注册表是可选第 2 参数，而 11 个 `new Agent(runtime)` 生产调用点里**只有 1 个**传了它 ⇒ CLI / 子代理 / 工作流 / eval 全部路径上，受种技能永不进上下文（真机修前：`--skills` 与配置文件两条通道都只有 user 事件、无 `# 技能：…`）。修法：`Agent` 构造函数缺省取运行时组合根那一份（`runtime.config.skillRegistry`），新增调用点不会再漏。
- **S2 `approval: "plan"` 被校验白名单拒绝**：`ENUM_VALUES.approval` 漏了 `'plan'`，而 CLI 枚举（`cliEnums.APPROVALS`）、`FileConfig.approval` 与运行时（`cliBuildConfig` 的 planMode 分支、`agentRuntimeHost` 的 `'plan'` 覆盖）都支持它 ⇒ 配置文件写 `"approval":"plan"` 直接报非法。已三处对齐并加回归用例。

**验证**：`tests/unit/configSkillsWiring.test.ts` 11/11（文件校验/映射、旗标解析、合并语义、两种文件形态、7 类非法输入的报错位置、`ConfigFactory.build` → 注册表、真 Agent 命中即注入 / 未命中零注入、`approval:'plan'` 回归）；**真机双通道实测**（`--model-adapter mock` 看事件流）两条通道各自注入 `# 技能：…` system 事件；`check --strict` 554 文件零违规、`audit:config-wiring` 554 文件全绿、`lint` 0 告警、`arch:gate` 0 违规、`format:check` 通过、全量单测 + 覆盖率达标记（覆盖率门禁 exit 0，行覆盖 100%）。文档：`omniharness.json.example` 补 `skills` 示例、`docs/integration.md` §6 补「受种技能」小节。
