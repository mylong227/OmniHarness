#!/usr/bin/env python3
"""Laya 本地推理桥：从 stdin 读 JSON 请求，单次前向完成 typed decision，结果写 stdout。

请求格式（与 TS DecisionEngine 对齐；questions 已是 laya 线格式）：
  {"repo": "...", "modelDir": "/abs/local/path", "request": {"state": "...",
   "questions": {"<name>": {"type": "noul"|"choice"|"score", "instructions": "...", "criteria": {...}|[...]}}}}
  {"repo": "...", "probe": true}   # 仅探测 laya 可 import（不下载权重）

响应格式：
  {"answers": {"<name>": {"choice"?:"", "score"?:float, "noul"?:float}}, "model":"...", "available":true}
  {"available":false, "note":"..."}   # 失败 / 不可用时

权重：若请求带 `modelDir`（本地已下载的 checkpoint 目录），直接用 `Agent(modelDir)` 加载
本地目录、不触网；否则 `Router()` 首个 predict 经 `HF_ENDPOINT` 镜像拉取（调用方已设
https://hf-mirror.com）。

注意：离线本地目录必须走 `Agent` 直载——`Router.predict(model=...)` 把 `model` 当作具名
checkpoint（english / multilingual / typed-decisions）而非路径，传本地目录会 `ValueError`。
"""
import sys
import json


def _write(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def _read_request_text():
    """读取请求 JSON 文本。

    优先从 `--request-file <path>` 读取（规避 Windows 子进程管道 EBUSY：输入走文件而非
    stdin 管道，TS 适配器一律以 `stdio:['ignore',...]` 调起、不建 stdin 管道）；未提供时
    回退读 stdin。两种来源均按 utf-8-sig 解码以容忍 BOM。
    """
    args = sys.argv[1:]
    if "--request-file" in args:
        idx = args.index("--request-file")
        if idx + 1 < len(args):
            with open(args[idx + 1], "r", encoding="utf-8-sig") as fh:
                return fh.read()
    return sys.stdin.buffer.read().decode("utf-8-sig")


def main():
    try:
        text = _read_request_text()
    except Exception as e:
        _write({"available": False, "note": "请求读取失败: %s" % str(e)[:200]})
        return

    try:
        data = json.loads(text)
    except Exception as e:
        _write({"available": False, "note": "JSON 解析失败: %s" % str(e)[:200]})
        return

    if data.get("probe"):
        try:
            import laya  # noqa: F401
            _write({"available": True})
        except Exception as e:
            _write({"available": False, "note": "laya 不可 import: %s" % str(e)[:200]})
        return

    try:
        from laya import Agent, Router
    except Exception as e:
        _write({"available": False, "note": "laya 未安装: %s" % str(e)[:200]})
        return

    repo = data.get("repo", "convaiinnovations/laya")
    model_dir = data.get("modelDir")
    req = data.get("request", {})
    state = req.get("state", "")
    questions = req.get("questions", {})

    try:
        if model_dir:
            # 本地离线 checkpoint：直接用 Agent 加载本地目录（目录存在即跳过下载、不触网）。
            # Router.predict(model=...) 把 model 当作具名 checkpoint 而非路径，本地目录必须走
            # Agent 直载路径。
            agent = Agent(model_dir)
            result = agent.system_one(state, questions)
            result["routing"] = {"model": model_dir}
        else:
            # 在线路径：Router 自动路由到具名 checkpoint（默认 english = convaiinnovations/laya 根）。
            router = Router()
            result = router.predict(state, questions)
    except Exception as e:
        _write({"available": False, "note": "推理失败: %s" % str(e)[:200]})
        return

    answers = {}
    for key, ans in result.get("answers", {}).items():
        item = {}
        if "choice" in ans:
            item["choice"] = ans["choice"]
        if "score" in ans:
            item["score"] = ans["score"]
        if "noul" in ans:
            item["noul"] = ans["noul"]
        answers[key] = item

    model = result.get("routing", {}).get("model", repo)
    _write({"answers": answers, "model": model, "available": True})


if __name__ == "__main__":
    main()
