# 零付费跑「产品口径」能力分的可行路径（调研 + 可执行方案，2026-09-26）

> 起因（用户口径）：「付费的事情最好就调研研究一份不要付费的完全取代掉」——
> 即：**不花 API 钱**拿到（或至少等效替代）原本要付费跑的「产品口径」SWE-bench 分数。

## 1. 先钉死要替代的是什么（口径）

| 项                   | 内容                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 付费项               | `benchmark/swebench_predict.mjs --best-of-n 4 --self-test`（产品口径：4 候选 + 测试驱动自纠环）跑 30 题 Verified 等距子集 |
| 判分                 | `benchmark/capability_swebench.mjs --verified`（本地 git+uv+pytest 复刻官方 judge，**免费**）                             |
| 成本量级（实测外推） | 单候选 30 题 ≈ **687K token**；本协议约 4–8× ⇒ **每臂 ~3–5M token**、数小时                                               |
| 交付物               | **resolved 率**（官方 FAIL_TO_PASS/PASS_TO_PASS 判定），不是 hitRate/召回率                                               |

⚠️ 注意：**判分已经不花钱**（本地执行器），花钱的只有「生成补丁」这一步。零付费替代只需替换**模型**这一环。

## 2. 三条零付费路线（成本 / 时延 / 质量 / 前置条件）

| #   | 路线                                                    | 花钱            | 前置条件                                                                             | 30 题 × N=4 的时延量级                                                                                                                                                  | 质量预期（诚实）                                                                                                 |
| --- | ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ①   | **本机推理**（Ollama / llama.cpp）+ 开源代码模型        | **0**           | 装运行时 + 下一个 GGUF（本机实测**当前没有**任何本地运行时）                         | 本机 i5-10210U / 16GB / 无可用 CUDA：7B-Q4 约 3–8 tok/s；单题 prompt ~25K token 预填充数分钟 + 生成数百 token ⇒ 单候选 ~10–20 min ⇒ **30×4 ≈ 20–40 小时**（可断点续跑） | 7B 级代码模型在 Verified 上通常个位数～十几个百分点；**低于**付费基线，但作回归标尺/离线对照足够                 |
| ②   | **免费额度 API**（Gemini 免费层 / 智谱 / DashScope 等） | **0（吃额度）** | 平台账号 + key；`defaults/providers.json` 已内置 `gemini`/`zhipu`/`dashscope` 等预设 | 受 RPD/TPM 限流；总调用数 = **120 次**（30 题 × 4 候选）                                                                                                                | 与付费同档（flash 级模型）⇒ **唯一能在零付费下与付费口径对等比较的路线**                                         |
| ③   | **零模型**：scripted/replay + gold/negative 控制        | **0**           | 无                                                                                   | 分钟级                                                                                                                                                                  | 只验证**管线**（判分器、环境、best-of-N/self-test 接线），**不是能力分**；已由 `npm run eval:ci` 覆盖            |
| ④   | **GitHub Models 免费层**（本机已有 GitHub 凭据）        | **0（吃额度）** | GitHub PAT；端点 `https://models.github.ai/inference`（OpenAI 兼容）                 | 受 RPD/RPM 限流；总调用数 = **120 次**（30 题 × 4 候选）                                                                                                                | 与付费 flash 级同档；**本机已有 `gho_` token**，是「零新增账号」即可试的一条（端点与额度**未实测**，跑前先冒烟） |

## 3. 已就绪 vs 缺什么（代码事实，不含猜测）

- **已就绪**：8 个厂商预设（`deepseek | moonshot | zhipu | dashscope | openai | anthropic | ollama | gemini`）；
  `src/adapters/model/llamaCppModel.ts`（Ollama 原生 `/api/chat`，默认 `http://localhost:11434`，**零密钥**）；
  `eval:ci`（零 key 的 scripted replay）；判分链路与 `--resume` 断点续跑。
- **本轮补齐**（`benchmark/swebench_predict.mjs`）：新增 `--base-url` 与 `--no-key`（并支持
  `OMNI_EVAL_BASE_URL` 环境变量），把**同一套协议**指向本地或免费的 OpenAI 兼容端点；
  缺 key 且未显式 `--no-key` 时**仍然 fail-closed**（不静默放行）；默认值逐字未变 ⇒ 付费路径零行为变更。
- **仍缺**（按路线）：① 需装运行时 + 模型（一次性下载 GB 级）；② 需免费层 key；③ 无需。

## 4. 可执行配方

### ① 本机（完全离线、零成本、慢）

```bash
# 一次性：装运行时 + 拉一个代码模型（示例）
ollama pull qwen2.5-coder:7b

# 生成（协议与付费口径逐字相同，只换模型端点）
node benchmark/swebench_predict.mjs \
  --model qwen2.5-coder:7b --base-url http://localhost:11434/v1 --no-key \
  --best-of-n 4 --self-test \
  --instance-list eval-data/verified30_ids.txt \
  --worktree-root eval-data/prepare_zerocost \
  --repo-base https://gitee.com/ --repo-mirrors benchmark/swebench-gitee-mirrors.json \
  --out eval-data/preds_zerocost.jsonl --resume

# 判分（本地，免费）
node benchmark/capability_swebench.mjs --verified eval-data/swe_bench_verified.json \
  --predictions eval-data/preds_zerocost.jsonl --instance-list eval-data/verified30_ids.txt \
  --repo-base https://gitee.com/ --repo-mirrors benchmark/swebench-gitee-mirrors.json \
  --jsonl eval-data/score_zerocost.jsonl --out eval-data/score_zerocost.json
```

（llama.cpp `llama-server` / LM Studio / vLLM 同样暴露 `/v1`，把 `--base-url` 指过去即可。）

### ② 免费额度 API（唯一能与付费口径对等比较）

```bash
node benchmark/swebench_predict.mjs \
  --model <免费层模型名> --base-url <厂商 OpenAI 兼容端点> \
  --best-of-n 4 --self-test --instance-list eval-data/verified30_ids.txt \
  --out eval-data/preds_free.jsonl --resume      # 不加 --no-key：走真实 key
```

限流时按日分片 + `--resume` 续跑（脚本已支持断点与并发锁）。

### ③ 零模型回归（CI 已有）

```bash
npm run eval:ci     # scripted replay + Pass@k 门禁，零 key、零网络、零成本
```

### ④ GitHub Models（零新增账号；端点/额度跑前必须冒烟）

本机**已经有** GitHub OAuth 凭据（`gho_`，存在 Windows 凭据管理器），因此这条路不需要新注册任何东西：

```bash
export GITHUB_TOKEN="$(git credential fill <<< 'protocol=https
host=github.com' | sed -n 's/^password=//p')"   # 或直接把 PAT 填进 .env
node benchmark/swebench_predict.mjs \
  --model <GitHub Models 上的模型名> \
  --base-url https://models.github.ai/inference --no-key=false \
  --best-of-n 4 --self-test --instance-list eval-data/verified30_ids.txt \
  --out eval-data/preds_ghmodels.jsonl --resume
```

⚠️ **三条必须跑前确认**（本文件不对未实测的东西下结论）：① 端点在 2026 年是否仍是
`https://models.github.ai/inference`（该服务正在并入 Azure AI Foundry，端点可能已迁移）；
② 免费层的 **RPD/RPM** 能否覆盖 120 次调用；③ 用 `repo` scope 的 OAuth token 调推理端点
是否符合 GitHub 当时的条款。冒烟方式：先用 `--instances <单题>` 跑 1 题，确认有补丁产出再放量。

## 5. 诚实边界（不承诺做不到的事）

1. **路线①的数字是外推估计**：本机**没有**任何本地推理运行时（ollama / llama.cpp / LM Studio 均未安装），
   时延与质量均未实测，必须先做一次单题冒烟再决定是否用它跑 30 题。
2. 免费层的额度/条款会变，须以跑前实测为准；额度不够时只能按日分片，谈不上「一次跑完」。
3. 各路线都**不改变**既有环境保真度边界：`best-of-effort` 环境（无 Docker 预建镜像）对它们同样成立
   ——环境层的问题不会因为换了模型而消失。
   ✅ **本轮进展（2026-09-26）**：环境层不再「静默背锅」——① 仓库本体 `-e .` 失败现在判 **envError**
   （不计入 resolved 分母，并附失败明细）；② 失败记录**必带原因**（F2P/P2P 计数 + 短诊断 + 未通过样例），
   环境/口径/真失败当场分流；③ django 的 per-repo 测试命令已复刻并**翻默认**（gold 14/14 判过）。
   因此「零付费跑出来的分低」现在可以归因，而不是把环境问题读成模型能力。
4. **取舍建议**：产品口径分走 **②免费层**（唯一可对话）或 **④GitHub Models**（零新增账号）；
   日常回归走 **①本地**（离线可反复）或 **③零模型**（最快、只保管线）。
   若长期需要稳定的官方口径对比，仍应保留一条付费基线作为参照系——零付费路线是**替代运行**，
   不是「同一模型换个入口」。
