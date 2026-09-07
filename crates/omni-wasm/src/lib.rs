//! wasm 插件边界：omni-core 编译为 wasm32 cdylib，暴露 C ABI 接口。
//!
//! TS 侧通过 WebAssembly 内存读写调用 `process`：
//!   1. 用 `omni_alloc(len)` 分配缓冲区，把 JSON-RPC 请求字符串写入 wasm 内存
//!   2. 调用 `process(ptr, len)` → 返回响应字符串的 (ptr, len) 打包进一个 i64
//!   3. 读取响应，调用 `omni_dealloc(ptr, len)` 释放
//!
//! 协议（JSON-RPC 风格）：
//!   请求  {"method":"tool_call","params":{"name":"echo","args":{"text":"hi"}}}
//!   响应  {"ok":true,"output":"...","events":[<tool_call事件>,<tool_result事件>]}

// wasm 单线程 FFI 内核：全局单例 `KERNEL`/`SESSION` 用 `static mut` 属设计使然
// （wasm 单线程，无多线程竞争）。`static_mut_refs` 是 rust_2024 兼容性警告，此处显式放行。
#![allow(static_mut_refs)]

use std::alloc::{alloc, dealloc as std_dealloc, Layout};
use std::os::raw::c_char;

use omni_core::{AgentLoop, EventType, Op, Session, Submission};
/// 全局内核实例（wasm 单例；静态线程不安全但 wasm 单线程）。
static mut KERNEL: Option<AgentLoop> = None;
/// 全局会话状态机（wasm 单例；承载 SQ/EQ、上下文、审批与沙箱）。
static mut SESSION: Option<Session> = None;

/// 导出：初始化内核并注册内置工具。幂等。
#[no_mangle]
pub extern "C" fn omni_init() {
    unsafe {
        if KERNEL.is_none() {
            let mut k = AgentLoop::new();
            // 注册内置工具集（文件类工具以 "." 为沙箱白名单根；wasm 下路径沙箱主要由宿主约束）。
            k.register_builtins(".");
            KERNEL = Some(k);
        }
    }
}

/// 取（必要时初始化）全局会话。
fn session_mut() -> &'static mut Session {
    unsafe {
        if SESSION.is_none() {
            SESSION = Some(Session::standard("wasm-session", "."));
        }
        SESSION.as_mut().expect("session")
    }
}

/// 导出：处理一条 JSON-RPC 请求。
/// 入参 `req_ptr`/`req_len` 指向请求 JSON 字符串；返回 (ptr,len) 打包进 i64。
#[no_mangle]
pub extern "C" fn process(req_ptr: *const c_char, req_len: usize) -> i64 {
    // 读取请求字符串。
    let req = unsafe {
        let slice = std::slice::from_raw_parts(req_ptr as *const u8, req_len);
        String::from_utf8_lossy(slice).into_owned()
    };

    // 解析 JSON-RPC 请求。
    let resp = handle(&req);

    // 分配响应缓冲区，返回 (ptr, len)。
    let bytes = resp.into_bytes();
    let len = bytes.len();
    let layout = Layout::array::<u8>(len).expect("layout");
    let ptr = unsafe { alloc(layout) };
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len) };
    pack_ptr_len(ptr as usize, len)
}

/// 导出：分配 len 字节缓冲区，返回指针（TS 侧写入请求）。
#[no_mangle]
pub extern "C" fn omni_alloc(len: usize) -> *mut c_char {
    let layout = Layout::array::<u8>(len).expect("layout");
    unsafe { alloc(layout) as *mut c_char }
}

/// 导出：释放 process 返回的缓冲区。
#[no_mangle]
pub extern "C" fn omni_dealloc(ptr: *mut c_char, len: usize) {
    unsafe { std_dealloc(ptr as *mut u8, Layout::array::<u8>(len).expect("layout")) };
}

/// 处理一条 JSON-RPC 请求，返回 JSON 响应。
fn handle(req: &str) -> String {
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
        "approval.check" => handle_approval_check(&v),
        "ping" => serde_json::json!({ "ok": true, "pong": true }).to_string(),
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
    let session = session_mut();
    session.submit(submission);
    session.run_until_idle();
    let ops = drain_ops(session);
    serde_json::json!({ "ok": true, "ops": ops }).to_string()
}

/// 处理 session.ops：取出尚未消费的出站操作。
fn handle_session_ops() -> String {
    let ops = drain_ops(session_mut());
    serde_json::json!({ "ok": true, "ops": ops }).to_string()
}

/// 处理 context.render：返回模型可见上下文与 token 估算。
fn handle_context_render() -> String {
    let session = session_mut();
    serde_json::json!({
        "ok": true,
        "tokens": session.context().estimate_tokens(),
        "context": session.render_context(),
    })
    .to_string()
}

/// 处理 approval.check：对一次工具调用做审批裁决（不改状态）。
fn handle_approval_check(v: &serde_json::Value) -> String {
    let params = v.get("params").cloned().unwrap_or(serde_json::json!({}));
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let args = params.get("args").cloned().unwrap_or(serde_json::json!({}));
    let decision = session_mut().approval_mut().evaluate(&name, &args);
    serde_json::json!({ "ok": true, "name": name, "decision": decision }).to_string()
}

/// 取出全部出站操作并序列化为 JSON 值。
fn drain_ops(session: &mut Session) -> Vec<serde_json::Value> {
    session.drain_ops().iter().map(Op::to_json_value).collect()
}

/// 处理 tools.list：返回内核已注册工具的元数据。
fn handle_tools_list() -> String {
    let kernel = unsafe {
        if KERNEL.is_none() {
            omni_init();
        }
        KERNEL.as_ref().expect("kernel")
    };
    let metas = kernel.list_tools();
    serde_json::json!({ "ok": true, "tools": metas }).to_string()
}

/// 处理 tool_call 方法。
fn handle_tool_call(v: &serde_json::Value) -> String {
    let params = v.get("params").cloned().unwrap_or(serde_json::json!({}));
    let name = params
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let args = params.get("args").cloned().unwrap_or(serde_json::json!({}));
    let call_id = params
        .get("callId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("call-1")
        .to_string();

    // 拿内核执行（未初始化则先 init）。
    let kernel = unsafe {
        if KERNEL.is_none() {
            omni_init();
        }
        KERNEL.as_ref().expect("kernel")
    };

    let (call_evt, result_evt) = kernel.run_tool("wasm-session", &call_id, &name, args);
    let ok = matches!(result_evt.r#type, EventType::ToolResult)
        && result_evt
            .payload
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
    let output = result_evt
        .payload
        .get("output")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();

    serde_json::json!({
        "ok": ok,
        "output": output,
        "events": [call_evt.to_json_value(), result_evt.to_json_value()],
    })
    .to_string()
}

/// 构造错误响应。
fn err_json(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

/// 把 (ptr, len) 打包进一个 i64（低 32 位 ptr，高 32 位 len）。
fn pack_ptr_len(ptr: usize, len: usize) -> i64 {
    ((ptr as i64) & 0xFFFF_FFFF) | (((len as i64) & 0xFFFF_FFFF) << 32)
}
