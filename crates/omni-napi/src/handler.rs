//! JS `call(json) -> json` 回调：JSON-RPC 分发。
//!
//! 与 omni-wasm 同一套方法面（tools.list / session.submit / session.ops /
//! context.render / approval.check / shell.run / tool_call / ping），但 native 版
//! 具备完整系统 API：真实时钟、真实进程、RestrictedToken OS 沙箱、shell.run 真执行
//! ——这就是 FFI 下沉的核心收益（wasm 侧 shell.run 不可用、无系统时钟）。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use omni_core::{estimate_text_tokens, AgentLoop, Op, Session, Submission};
use serde_json::json;

use crate::napi_glue::{self, NapiCallbackInfo, NapiEnv, NapiValue};

/// 全局内核（native 注册全部 7 工具，含 shell.run）。
static KERNEL: OnceLock<Mutex<AgentLoop>> = OnceLock::new();
/// 全局会话状态机（审批 → 策略沙箱 → OS 沙箱 → 执行 → 记录 全链）。
static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();

/// native 内核沙箱根目录：取进程当前工作目录（绝对路径）。
/// 原为 "." 时 `within()` 词法校验会拒绝绝对路径与相对文件名，导致 fs.* 经原生路径不可用；
/// 改为绝对 cwd 后，绝对路径（须在 cwd 内）与相对文件名（拼接至 cwd）均可正常通过沙箱。
fn native_root() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn kernel() -> MutexGuard<'static, AgentLoop> {
    KERNEL
        .get_or_init(|| {
            let mut k = AgentLoop::new();
            k.register_builtins(native_root());
            Mutex::new(k)
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn session() -> MutexGuard<'static, Session> {
    SESSION
        .get_or_init(|| Mutex::new(Session::standard("native-session", native_root())))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// JS 侧 `call(jsonString) -> jsonString`。catch_unwind 兜住内核 panic，不让宿主 Node 崩。
pub unsafe extern "C" fn call_cb(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let result = std::panic::catch_unwind(|| unsafe { invoke(env, info) });
    match result {
        Ok(v) => v,
        Err(_) => napi_glue::throw(env, "panic: 内核执行异常"),
    }
}

unsafe fn invoke(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let t = napi_glue::table();
    let mut argc = 1usize;
    let mut argv = [std::ptr::null_mut::<std::os::raw::c_void>(); 1];
    let status = (t.get_cb_info)(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    if status != napi_glue::NAPI_OK || argc < 1 {
        return napi_glue::throw(env, "缺少参数");
    }
    let req = match napi_glue::get_string(env, argv[0]) {
        Some(s) => s,
        None => return napi_glue::throw(env, "参数必须是字符串"),
    };
    let resp = dispatch(&req);
    napi_glue::new_string(env, &resp)
}

/// 分发一条 JSON-RPC 请求，返回 JSON 响应字符串。
fn dispatch(req: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(req) {
        Ok(v) => v,
        Err(_) => return err_json("请求不是合法 JSON-RPC"),
    };
    let method = v
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match method {
        "tool_call" => handle_tool_call(&v),
        "tools.list" => handle_tools_list(),
        "session.submit" => handle_session_submit(&v),
        "session.ops" => handle_session_ops(),
        "context.render" => handle_context_render(),
        "context.estimate" => handle_context_estimate(&v),
        "approval.check" => handle_approval_check(&v),
        "ping" => json!({ "ok": true, "pong": true, "native": true }).to_string(),
        _ => err_json(&format!("未知方法: {}", method)),
    }
}

/// 处理 session.submit：提交一条 Submission 并驱动状态机，返回出站 Op 列表。
fn handle_session_submit(v: &serde_json::Value) -> String {
    let submission: Submission = match serde_json::from_value(
        v.get("params")
            .and_then(|p| p.get("submission"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    ) {
        Ok(s) => s,
        Err(e) => return err_json(&format!("非法 submission: {}", e)),
    };
    let mut s = session();
    s.submit(submission);
    s.run_until_idle();
    let ops = drain_ops(&mut s);
    json!({ "ok": true, "ops": ops }).to_string()
}

/// 处理 session.ops：取出尚未消费的出站操作。
fn handle_session_ops() -> String {
    let ops = drain_ops(&mut session());
    json!({ "ok": true, "ops": ops }).to_string()
}

/// 处理 context.render：返回模型可见上下文与 token 估算。
fn handle_context_render() -> String {
    let s = session();
    json!({
        "ok": true,
        "tokens": s.context().estimate_tokens(),
        "context": s.render_context(),
    })
    .to_string()
}

/// 处理 context.estimate：批量估算消息列表 token 数（对齐 TS TokenEstimator.estimateMessages：
/// 每条 content 估算 token + 4 角色开销）。单次 FFI 往返，避免逐条调用放大往返成本。
fn handle_context_estimate(v: &serde_json::Value) -> String {
    let params = v.get("params").cloned().unwrap_or(json!({}));
    let messages = params
        .get("messages")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let mut total: usize = 0;
    for m in &messages {
        let content = m
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        total += estimate_text_tokens(&content) + 4;
    }
    json!({ "ok": true, "tokens": total }).to_string()
}

/// 处理 approval.check：对一次工具调用做审批裁决（不改状态）。
fn handle_approval_check(v: &serde_json::Value) -> String {
    let params = v.get("params").cloned().unwrap_or(json!({}));
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let args = params.get("args").cloned().unwrap_or(json!({}));
    let decision = session().approval_mut().evaluate(&name, &args);
    json!({ "ok": true, "name": name, "decision": decision }).to_string()
}

/// 取出全部出站操作并序列化为 JSON 值。
fn drain_ops(session: &mut Session) -> Vec<serde_json::Value> {
    session.drain_ops().iter().map(Op::to_json_value).collect()
}

/// 处理 tools.list：返回内核已注册工具的元数据（native 含 shell.run，共 7 个）。
fn handle_tools_list() -> String {
    let metas = kernel().list_tools();
    json!({ "ok": true, "tools": metas }).to_string()
}

/// 处理 tool_call：经 Session 全链执行一次工具（审批 → 策略沙箱 → OS 沙箱 → 执行 → 记录）。
/// 返回 {ok, output, wrapped, ops}：wrapped 标记命令是否被 OS 沙箱包装。
fn handle_tool_call(v: &serde_json::Value) -> String {
    let params = v.get("params").cloned().unwrap_or(json!({}));
    let name = params
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let args = params.get("args").cloned().unwrap_or(json!({}));
    let call_id = params
        .get("callId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("call-1")
        .to_string();

    let mut s = session();
    s.submit(Submission::ToolCall {
        call_id: call_id.clone(),
        name: name.clone(),
        args: args.clone(),
    });
    s.run_until_idle();
    let ops = s.drain_ops();

    let mut ok = false;
    let mut output = String::new();
    let mut executed_args = args.clone();
    let mut rejected = false;
    for op in &ops {
        match op {
            Op::ToolResult {
                call_id: c,
                ok: o,
                output: out,
            } if *c == call_id => {
                ok = *o;
                output = out.clone();
            }
            Op::ToolCall {
                call_id: c,
                args: a,
                ..
            } if *c == call_id => {
                executed_args = a.clone();
            }
            Op::Error { .. } => {
                rejected = true;
            }
            _ => {}
        }
    }
    let wrapped = executed_args.get("command") != args.get("command");

    json!({
        "ok": ok,
        "output": output,
        "wrapped": wrapped,
        "rejected": rejected,
        "ops": ops.iter().map(Op::to_json_value).collect::<Vec<_>>(),
    })
    .to_string()
}

/// 构造错误响应。
fn err_json(msg: &str) -> String {
    json!({ "ok": false, "error": msg }).to_string()
}
