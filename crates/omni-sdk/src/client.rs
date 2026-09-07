//! JSON-RPC 2.0 客户端：请求-响应 + 通知订阅（对齐 TS `src/sdk/sdkClient.ts`）。

use serde::{Deserialize, Serialize};

use crate::transport::Transport;

/// JSON-RPC 错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    /// 传输层错误。
    Transport(String),
    /// 协议错误（非法 JSON / 缺少字段）。
    Protocol(String),
    /// 服务端返回的错误对象。
    Remote { code: i64, message: String },
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Transport(msg) => write!(f, "传输错误: {}", msg),
            RpcError::Protocol(msg) => write!(f, "协议错误: {}", msg),
            RpcError::Remote { code, message } => write!(f, "服务端错误 {}: {}", code, message),
        }
    }
}

impl std::error::Error for RpcError {}

/// 服务端主动推送的通知（无 id 的入站帧）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    /// 通知方法名（如事件推送）。
    pub method: String,
    /// 通知参数。
    pub params: serde_json::Value,
}

/// OmniHarness 客户端：一个连接一个客户端，请求与订阅共用通道。
pub struct OmniClient<T: Transport> {
    transport: T,
    next_id: u64,
}

impl<T: Transport> OmniClient<T> {
    /// 以传输实例构造。
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: 1,
        }
    }

    /// 底层传输只读访问。
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// 发起请求并等待同 id 响应（期间收到的通知被缓存丢弃风险——由调用方先订阅）。
    pub fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.transport
            .send_line(&frame.to_string())
            .map_err(|e| RpcError::Transport(e.to_string()))?;
        self.await_response(id)
    }

    /// 发送通知（不等待响应）。
    pub fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), RpcError> {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.transport
            .send_line(&frame.to_string())
            .map_err(|e| RpcError::Transport(e.to_string()))
    }

    /// 读取一条入站帧；是响应则回 Err(协议错误) 的语义交由 `await_response` 处理。
    /// 本方法面向订阅场景：返回通知，遇到响应帧时透传为 `Notification` 的 `method="#response"`。
    pub fn read_notification(&mut self) -> Result<Option<Notification>, RpcError> {
        let Some(line) = self
            .transport
            .recv_line()
            .map_err(|e| RpcError::Transport(e.to_string()))?
        else {
            return Ok(None);
        };
        let frame: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| RpcError::Protocol(e.to_string()))?;
        if let Some(method) = frame.get("method").and_then(|v| v.as_str()) {
            return Ok(Some(Notification {
                method: method.to_string(),
                params: frame
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            }));
        }
        Ok(Some(Notification {
            method: "#response".to_string(),
            params: frame,
        }))
    }

    /// 等待指定 id 的响应：跳过期间到达的通知（通知内容丢弃，订阅需用独立连接）。
    fn await_response(&mut self, id: u64) -> Result<serde_json::Value, RpcError> {
        loop {
            let Some(line) = self
                .transport
                .recv_line()
                .map_err(|e| RpcError::Transport(e.to_string()))?
            else {
                return Err(RpcError::Transport("连接已关闭".to_string()));
            };
            let frame: serde_json::Value =
                serde_json::from_str(&line).map_err(|e| RpcError::Protocol(e.to_string()))?;
            if frame.get("id").and_then(|v| v.as_u64()) != Some(id) {
                continue;
            }
            if let Some(error) = frame.get("error") {
                let code = error.get("code").and_then(|v| v.as_i64()).unwrap_or(-32000);
                let message = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误")
                    .to_string();
                return Err(RpcError::Remote { code, message });
            }
            return Ok(frame
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }
    }
}
