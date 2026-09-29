#!/usr/bin/env python3
"""Laya 本地推理桥：从 stdin 读 JSON 请求，单次前向完成 typed decision，结果写 stdout。

请求格式（与 TS DecisionEngine 对齐）：
  {"repo": "...", "request": {"state": "...", "questions": {"<name>": {"kind": "noul"|"choice"|"score", "instructions": "...", "criteria": {...}|[...]}}}}
  {"repo": "...", "probe": true}   # 仅探测 laya 可 import（不下载权重）

响应格式：
  {"answers": {"<name>": {"choice"?:"", "score"?:float, "noul"?:float}}, "model":"...", "available":true}
  {"available":false, "note":"..."}   # 失败 / 不可用时

权重经 HF_ENDPOINT 镜像拉取（调用方已设 https://hf-mirror.com）。
"""
import sys
import json


def _write(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def main():
    try:
        text = sys.stdin.buffer.read().decode("utf-8")
    except Exception as e:
        _write({"available": False, "note": "stdin 读取失败: %s" % str(e)[:200]})
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
        from laya import Router
    except Exception as e:
        _write({"available": False, "note": "laya 未安装: %s" % str(e)[:200]})
        return

    repo = data.get("repo", "convaiinnovations/laya-typed-decisions")
    req = data.get("request", {})
    state = req.get("state", "")
    questions = req.get("questions", {})

    try:
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
