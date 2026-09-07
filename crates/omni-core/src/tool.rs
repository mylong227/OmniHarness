//! 工具端口：Rust 内核暴露稳定能力接口，TS 插件注册/拦截事件。

use serde::{Deserialize, Serialize};

/// 工具调用参数（JSON 透传）。
pub type ToolArgs = serde_json::Value;

/// 工具结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    pub error: Option<String>,
}

impl ToolResult {
    /// 构造成功结果。
    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            ok: true,
            output: output.into(),
            error: None,
        }
    }

    /// 构造失败结果。
    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: String::new(),
            error: Some(message.into()),
        }
    }
}

/// 工具定义：一个函数一个职责。
pub trait Tool: Send + Sync {
    /// 工具名（TS 侧用它路由）。
    fn name(&self) -> &str;
    /// 执行工具调用。
    fn call(&self, args: ToolArgs) -> ToolResult;
    /// 工具元数据（对齐蓝图 ToolSpec JSON schema）。默认派生自 name。
    fn meta(&self) -> ToolMeta {
        ToolMeta {
            name: self.name().to_string(),
            description: String::new(),
            param_schema: serde_json::json!({}),
        }
    }
}

/// 工具元数据：供运行时自省、TS 侧生成 ToolSpec / 权限判定。
/// 对齐蓝图「ToolSpec JSON schema」——由单份声明驱动（name/description/参数 schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolMeta {
    pub name: String,
    pub description: String,
    /// 参数 JSON schema（对象，字段名→{type, required, description}）。
    pub param_schema: serde_json::Value,
}

impl ToolMeta {
    /// 便捷构造。
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        param_schema: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            param_schema,
        }
    }
}
