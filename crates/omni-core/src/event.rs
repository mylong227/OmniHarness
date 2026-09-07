//! 事件模型：Rust 内核与 TS 侧通过 JSON 事件流互操作。

use serde::{Deserialize, Serialize};

/// 会话事件类型（与 TS 侧 SessionEvent.type 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    User,
    Assistant,
    Reasoning,
    ToolCall,
    ToolResult,
    System,
}

/// 会话事件：模型所见即所记的唯一事实源（与 TS 侧 SessionEvent 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    pub r#type: EventType,
    pub session_id: String,
    pub timestamp: String,
    pub payload: serde_json::Value,
}

impl SessionEvent {
    /// 构造一条工具调用事件。
    pub fn tool_call(session_id: &str, call_id: &str, name: &str, args: serde_json::Value) -> Self {
        Self {
            id: format!("evt_{}", call_id),
            r#type: EventType::ToolCall,
            session_id: session_id.to_string(),
            timestamp: now_iso(),
            payload: serde_json::json!({ "callId": call_id, "name": name, "args": args }),
        }
    }

    /// 构造一条工具结果事件。
    pub fn tool_result(session_id: &str, call_id: &str, ok: bool, output: &str) -> Self {
        Self {
            id: format!("evt_{}", call_id),
            r#type: EventType::ToolResult,
            session_id: session_id.to_string(),
            timestamp: now_iso(),
            payload: serde_json::json!({ "callId": call_id, "ok": ok, "output": output }),
        }
    }

    /// 序列化为 JSON 字符串。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// 序列化为 JSON 值（便于嵌入复合响应）。
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

/// 当前时间 ISO8601。
/// - native（Windows/Linux）：基于系统时钟。
/// - wasm32：无系统时钟（SystemTime::now 会 panic），用单调计数器近似。
pub fn now_iso() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{}s", now)
    }
    #[cfg(target_arch = "wasm32")]
    {
        // wasm 无时钟：用模块内单调计数器，保证事件顺序可区分。
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("wasm_{}", n)
    }
}
