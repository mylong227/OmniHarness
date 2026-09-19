---
'omniharness': minor
---

去 Docker 化：Terminal-Bench 环境契约改为容器无关。删除 `src/benchmark/terminalbench/dockerfileReader.ts` 与契约里的全部 Docker 语义（`imageBase` / `dockerfilePath` / `workingDir` / `copyDirectives` / `setupCommands`、`SetupCommand` / `CopyDirective`），改为新增 `taskEnvironment.ts`——任务用 `env.json` 显式声明 `python` / `pip` / `apt` / `shell` / `seeds`，未声明的字段回落 Python 生态标准清单（`.python-version` / `requirements.txt` / `pyproject.toml#requires-python` / `apt.txt`，Binder·uv 同款约定），`pip` 参数原样透传给宿主的 `uv pip install`（无镜像拉取、无层解压，且 `-e .[dev]` 这类可编辑安装照样表达）。原生给不出的声明（apt 系统包、构建期 shell 步骤）逐条进 `warnings`，不假装成功；语料侧 20 题的 `Dockerfile`/`docker-compose.yaml` 已删除（环境改由每题 `env.json` 表达）。顺带修正 `TaskParser` 未绝对化路径导致相对 `--tasks` 下参考解 `exit 127`、把环境边界误记成能力失败的真缺陷。
