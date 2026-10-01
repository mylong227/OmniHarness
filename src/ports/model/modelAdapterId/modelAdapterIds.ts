/**
 * 全部模型适配器标识（顺序 = CLI `--help` 与枚举提示的展示顺序）。
 *
 * 改动纪律：值是**对外契约**（`omniharness.json` 的 `modelAdapter`、`--model-adapter`、
 * modelRouter 条目的 `adapter`），增删属破坏性变更，须同步 `defaults/endpoints.json`
 * （适配器的兜底端点/模型/env 名按同名 id 组织）与 `defaults/providers.json`（厂商的 `adapter`）。
 */
export const MODEL_ADAPTER_IDS = ['mock', 'openai', 'anthropic', 'responses', 'llamacpp'] as const;
