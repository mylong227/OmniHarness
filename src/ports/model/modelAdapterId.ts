/**
 * 模型适配器标识清单（**唯一声明处**；审计 §3.4 收口的最后一段）。
 *
 * ## 为什么单独成端口文件
 *
 * 这组名字此前在 **5 处**各写一遍：`CliArgs.modelAdapter`、`FileConfig.modelAdapter`、
 * `cliEnums.MODEL_ADAPTERS`、`configError.ENUM_VALUES.modelAdapter`、daemon 的 `RoutineModelAdapter`
 * （外加厂商预设的 `adapter` 子集）。实测其中一处已经漂移过：配置文件校验白名单漏了 `llamacpp`
 * ⇒ `omniharness.json` 里写 `"modelAdapter": "llamacpp"` 被判非法（声明支持、校验拒绝）。
 *
 * 放**端口层**是因为消费方横跨 cli / config / daemon / adapters，而 `daemon/**` 的允许依赖只有
 * `ports/**`（见 `ARCHITECTURE_SPEC.md` §2.1）⇒ 只有端口层能被所有消费方合法引用。
 * 本文件是纯常量 + 纯类型（无 class、无第三方、无逻辑）。
 *
 * ## 与注册表的关系
 *
 * 本清单是「有哪些适配器」的**名字来源**；`adapters/model/modelAdapterRegistry.ts` 的表必须
 * 为每个名字给出一行构造器（用 `Record<ModelAdapterId, …>` 表达 ⇒ **漏一行即编译报错**，
 * 不需要运行时校验）。两者合起来构成单一来源。
 */

/**
 * 全部模型适配器标识（顺序 = CLI `--help` 与枚举提示的展示顺序）。
 *
 * 改动纪律：值是**对外契约**（`omniharness.json` 的 `modelAdapter`、`--model-adapter`、
 * modelRouter 条目的 `adapter`），增删属破坏性变更，须同步 `defaults/endpoints.json`
 * （适配器的兜底端点/模型/env 名按同名 id 组织）与 `defaults/providers.json`（厂商的 `adapter`）。
 */
export const MODEL_ADAPTER_IDS = ['mock', 'openai', 'anthropic', 'responses', 'llamacpp'] as const;

/** 模型适配器标识联合类型（由清单推导，不再手写）。 */
export type ModelAdapterId = (typeof MODEL_ADAPTER_IDS)[number];

/**
 * 厂商预设可用的适配器子集：`mock` 不连任何端点、`llamacpp` 是本地原生协议，
 * 两者都不适合做「厂商」预设（预设必须有端点与模型清单）。
 */
export type ProviderAdapterId = Exclude<ModelAdapterId, 'mock' | 'llamacpp'>;
