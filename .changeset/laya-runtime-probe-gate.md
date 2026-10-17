---
'@mylong227/omniharness': patch
---

Laya 运行时**已修复**（真前向 5/5 通过），并把它前面暴露的**判据口径缺陷**一并修掉。

## 现象与根因（一条命令取证）

`tests/integration/layaBackend.test.ts` 5 例全红，报 `热进程应在 300s 内完成权重加载`。
直接跑那个 venv 解释器 ⇒ 它自报
`did not find executable at 'C:\Users\…\.workbuddy\binaries\python\versions\3.13.12\python.exe'`：
该目录已被托管工具清空，而 venv 里的 `Scripts/python.exe` 只是**启动器**（读 `pyvenv.cfg` 的 `home=` 去找
`python313.dll` 与标准库）——**文件一个不少，就是跑不起来**，1.7GB 运行时因此静默失效。

## 判据口径修正（长期保留的那一半）

旧 `SKIP_REASON` 只看 `existsSync(python)`，把"**文件在**"当成了"**可用**"，
于是环境缺件表现为 5 条判据全红（把"我没装好"说成"产品坏了"）。现在真跑一次 `<python> --version`
（20s 超时、退出码 0 才算可用），并把不可用的两种形态分别写进 skip 原因；
**`OMNI_REQUIRE_LAYAPY=1` 的语义未变**——在该环境下前提不成立仍然**失败**，不因这次改动把强制项变成静默跳过。

## 运行时修复（三步，配方已写进 `THIRD_PARTY_ASSETS.md`）

1. 取证同上（`--version` 报 shim 指向的基础解释器不存在）；
2. `uv python install 3.13`（本机 `uv` 在 `~/.local/bin/uv.exe`；实测下载 21MB / 约 2 分钟）。
   **必须同小版本**：venv 内是 cp313 轮子，3.12 的 `python312.dll` 不兼容；
3. 把解释器整体复制为 `third-party/laya-python/`（61MB，已加 gitignore），把 `pyvenv.cfg` 的
   `home` / `executable` / `command` 三行改指它 —— **复制而不是引用 uv 缓存**：那份随时可能被清理，
   放进 `third-party/` 后修复不再依赖任何外部状态。
   **坑（当场踩到，已写进文档）**：`pyvenv.cfg` 含中文用户名，`Set-Content -Encoding ascii` 会写成
   `C:\Users\???\…`，症状与"文件缺失"一模一样 ⇒ 必须用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。

## 验证（真前向，不是 skip）

- `third-party/laya-venv/Scripts/python.exe -c "import torch, transformers, laya; print(torch.__version__)"`
  ⇒ `2.14.0+cpu / 5.17.0`，且 `sys.base_prefix` 指向 `third-party/laya-python`（自包含）。
- `OMNI_REQUIRE_LAYAPY=1 node --test dist/tests/integration/layaBackend.test.js` ⇒ **5/5 通过**
  （含 842MB 权重加载与热路径单次秒级）。
- `tests/integration/**` 全量 ⇒ **16/16、0 跳过、0 失败**。
