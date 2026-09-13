# 端口契约（PORTS_CONTRACT · P8.3）

> 目的：让**第三方可以实现 OmniHarness 的端口**（嵌入方、扩展者、评测框架），而不必阅读适配器源码。
> 口径来源：`src/ports/**`（唯一权威）+ `docs/ARCHITECTURE_SPEC.md` §2.1 归属表。
> 三条硬规则（对实现者同样生效）：
> ① 端口层零第三方依赖；② 实现须通过对应端口测试（`tests/unit/*` 中的端口契约用例）；③ fail-closed 语义不得放宽。

## 1. 端口分类与接入门槛

| 级别                         | 端口                                                                                                                                                                                                                                     | 说明                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **核心必选**（嵌入必须提供） | `model`、`tool`、`storage`、`eventPort`、`approval`、`sandbox`、`userResponder`                                                                                                                                                          | 运行一次 turn 的最小闭环；`model` 是唯一必须对接外部 LLM 的端口 |
| **常用可选**                 | `kv`、`vault`、`checkpointManager`、`longTermMemory`、`resonantField`、`retrieval`、`embedding`、`spill`、`todo`、`plan`、`skill`、`workspaceSnapshot`                                                                                   | 记忆/检索/检查点能力，缺省有内置适配器，可整体替换              |
| **高级扩展**                 | `agent`、`subagent`、`supervisor`、`confinement`、`policy`、`escalation`、`evolution`、`metacognition`、`immune`、`qec`、`oobleck`、`memoryAnnealing`、`insightEtching`、`symmetryBreaking`、`vortexRing`、`cosmicWeb`、`resonantMemory` | 发明层/治理层机制端口，实现须带 `@maturity` 声明与证据（见 §4） |
| **回调/钩子**                | `toolHook`、`toolInputSink`、`turnDiffTracker`、`eventFactory`、`memoryExtractor`、`sandboxDenial`                                                                                                                                       | 供宿主监听与注入；实现不得阻塞主循环                            |

完整接口清单以 `src/ports/` 目录为准（文件名 = 端口名，camelCase）。

## 2. 实现一个端口的标准步骤

1. `npm run check` 确认零依赖预算可用（实现文件只允许在 `adapters/` 或宿主仓库）。
2. 新建 `adapters/<域>/<你的实现名>.ts`：`export class YourImpl implements <Port> { ... }`，
   文件名 = 类名（camelCase/PascalCase 对应），一文件一类。
3. 公开成员显式 `public`/`private`；公开类与方法必须有 JSDoc（含 `@param`/`@returns`）——
   `audit:standard:delta` 会对新文件全量拦截（无历史债务豁免）。
4. 在组合根（`config/` 装配函数或嵌入方的 `ConfigFactory` 调用处）替换默认适配器；
   **禁止在实现内部 `new` 其他具体实现**（构造注入）。
5. 跑端口契约测试 + 四闸门（typecheck / test / lint / check --strict）。

## 3. 稳定性与废弃（对接 `docs/API_STABILITY.md`）

- 端口方法签名遵循语义化版本：`@public` 端口的破坏性变更走主版本号；`@beta` 端口随时可调。
- 废弃流程：先加 `@deprecated` + 迁移指引一个次版本，再移除；`api:check` 门禁强制导出分区标注。

## 4. 机制端口的成熟度要求（对齐 T0）

以物理/生物/化学概念命名的机制端口实现（如 `qec`、`oobleck`、`resonantField`）必须：

- 文件头声明 `@maturity L0|L1|L2|L3 — 判据`；
- L2/L3 必须提供 `@maturityEvidence <测试文件>` 且测试真实 import 该实现；
- `npm run audit:maturity` 在 CI 阻断（无证据的 L2/L3 即红）。

## 5. 最小接入示例（伪代码）

```ts
import { ConfigFactory } from 'omniharness';
import { MyModel } from './myModel.js'; // implements ModelPort

const runtime = ConfigFactory.build({
  model: () => new MyModel(), // 组合根注入，替换默认适配器
  approval: 'rules',
});
await runtime.agent.runTask('hello');
```

> 实现方注意：`ModelPort.stream()` 的取消语义以 `AbortSignal` 为准；中途抛错请抛
> `ModelCallError`（`src/errors/modelCallError.ts`），让重试/预算链路可辨识。
