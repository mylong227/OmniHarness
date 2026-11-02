#!/usr/bin/env python3
"""Laya 本地推理桥：把「类型化决策（noul / choice / score）」暴露给 TS 适配器。

## 两种运行模式

- **单发模式（默认）**：读一个请求、写一个响应、进程退出。请求优先从 `--request-file <path>`
  读取（规避本机 Windows 同步子进程建 stdin 管道即 EBUSY 的老问题），未提供时回退读 stdin。
- **常驻模式（`--serve`）**：JSONL over stdio，**一次加载、多次前向**。这是「真正用得起」的关键：
  实测本机（torch 2.14 CPU + 421M 权重）每次新起进程要重新 import torch 并加载 842MB 权重，
  单次 18–62s；常驻后首次 15s（含 11.6s 加载）、其后每次 **约 0.4s**。

## 协议（两种模式同一份语义）

请求（每行一个 JSON）：
  {"id"?: <any>, "probe": true}                              # 仅探测 `import laya`，不加载权重
  {"id"?: <any>, "warmup": true, "modelDir"?: <abs dir>}     # 预加载权重（常驻模式用，减少首帧延迟）
  {"id"?: <any>, "repo"?: <str>, "modelDir"?: <abs dir>,
   "request": {"state": <str>, "questions": {"<name>": {"type": "noul"|"choice"|"score",
               "instructions": <str>, "criteria"?: {...}|[...]}}}}

响应（每行一个 JSON；`id` 原样回带）：
  {"available": true,  "answers": {"<name>": {"choice"?:"", "score"?:float, "noul"?:float}}, "model": <str>}
  {"available": false, "note": "<失败原因>"}                  # 失败 / 不可用（调用方 fail-open）

## 两处工程细节（都踩过）

1. **协议 stdout 必须干净**：第三方库（transformers / torch / huggingface_hub）偶有 `print`
   写入 stdout，会污染 JSONL 分帧。故启动时把 `sys.stdout` 换成 stderr，协议帧走**保留的原始句柄**。
2. **本地目录必须走 `Agent` 直载**：`Router.predict(model=...)` 把 `model` 当具名 checkpoint
   （english / multilingual / typed-decisions）而非路径，传本地目录会 `ValueError`。

权重来源：请求带 `modelDir` 时用本地目录（`Agent(modelDir)`，不触网）；否则 `Router()`
首个 predict 经 `HF_ENDPOINT` 镜像拉取（调用方已设 https://hf-mirror.com）。
"""
import json
import sys
import time

# 协议专用输出句柄：先占住真实 stdout，再把 stdlib 的 stdout 换成 stderr，
# 使任何第三方库的 print 都不会插进协议帧之间。
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

DEFAULT_REPO = "convaiinnovations/laya"


class Bridge:
    """推理会话：按需加载（懒加载）并复用同一个 `Agent`，常驻模式下只加载一次。"""

    def __init__(self):
        """初始化空会话（不加载任何权重，避免 probe 也付出加载代价）。"""
        self._agent = None
        self._agent_dir = None

    def probe(self):
        """仅探测 `laya` 是否可 import（不加载权重、不触网）。"""
        try:
            import laya  # noqa: F401

            return {"available": True}
        except Exception as e:  # pragma: no cover - 环境相关
            return {"available": False, "note": "laya 不可 import: %s" % str(e)[:200]}

    def agent(self, model_dir):
        """取（必要时加载）本地 checkpoint 的 `Agent`；`model_dir` 为空时返回 None（走 Router）。"""
        if not model_dir:
            return None
        if self._agent is None or self._agent_dir != model_dir:
            from laya import Agent

            started = time.time()
            self._agent = Agent(model_dir)
            self._agent_dir = model_dir
            sys.stderr.write("laya: loaded %s in %.1fs\n" % (model_dir, time.time() - started))
            sys.stderr.flush()
        return self._agent

    def infer(self, data):
        """执行一次类型化决策。`data` 为请求体；返回响应体（永不抛错，失败即 `available:false`）。"""
        repo = data.get("repo") or DEFAULT_REPO
        model_dir = data.get("modelDir") or None
        req = data.get("request") or {}
        state = req.get("state", "")
        questions = req.get("questions", {})
        started = time.time()
        try:
            if model_dir:
                # 本地离线 checkpoint：目录存在即跳过下载、不触网。
                result = self.agent(model_dir).system_one(state, questions)
                routing = {"model": model_dir}
            else:
                # 在线路径：Router 自动路由到具名 checkpoint（默认 english = 上游根 checkpoint）。
                from laya import Router

                result = Router().predict(state, questions)
                routing = result.get("routing") or {"model": repo}
        except Exception as e:
            return {"available": False, "note": "推理失败: %s" % str(e)[:200]}

        answers = {}
        for key, ans in (result.get("answers") or {}).items():
            item = {}
            for primitive in ("choice", "score", "noul"):
                if primitive in ans:
                    item[primitive] = ans[primitive]
            answers[key] = item
        return {
            "answers": answers,
            "model": routing.get("model", repo),
            "available": True,
            "ms": int((time.time() - started) * 1000),
        }


def write_frame(obj):
    """写一帧协议响应（单行 JSON + 换行 + 立即 flush）。"""
    _PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def handle(bridge, data):
    """按请求类型分派：probe / warmup / 推理。`data` 为已解析的请求对象。"""
    if data.get("probe"):
        return bridge.probe()
    if data.get("warmup"):
        model_dir = data.get("modelDir") or None
        started = time.time()
        try:
            bridge.agent(model_dir)
        except Exception as e:
            return {"available": False, "note": "预加载失败: %s" % str(e)[:200]}
        return {"available": True, "warmup": True, "ms": int((time.time() - started) * 1000)}
    return bridge.infer(data)


def read_request_text(argv):
    """读取单发模式的请求文本：优先 `--request-file <path>`，否则读 stdin（均容忍 BOM）。"""
    if "--request-file" in argv:
        idx = argv.index("--request-file")
        if idx + 1 < len(argv):
            with open(argv[idx + 1], "r", encoding="utf-8-sig") as fh:
                return fh.read()
    return sys.stdin.buffer.read().decode("utf-8-sig")


def run_serve(bridge):
    """常驻模式主循环：逐行读 JSON 请求、逐帧写响应；坏行只回一帧错误、不退出。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except Exception as e:
            write_frame({"available": False, "note": "JSON 解析失败: %s" % str(e)[:200]})
            continue
        response = handle(bridge, data)
        if "id" in data:
            response["id"] = data["id"]
        write_frame(response)


def run_once(bridge, argv):
    """单发模式：一个请求、一个响应、退出。"""
    try:
        text = read_request_text(argv)
    except Exception as e:
        write_frame({"available": False, "note": "请求读取失败: %s" % str(e)[:200]})
        return
    try:
        data = json.loads(text)
    except Exception as e:
        write_frame({"available": False, "note": "JSON 解析失败: %s" % str(e)[:200]})
        return
    write_frame(handle(bridge, data))


def main():
    """入口：`--serve` 走常驻模式，否则单发。"""
    bridge = Bridge()
    argv = sys.argv[1:]
    if "--serve" in argv:
        run_serve(bridge)
    else:
        run_once(bridge, argv)


if __name__ == "__main__":
    main()
