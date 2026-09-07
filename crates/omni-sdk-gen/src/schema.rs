//! 协议 schema 的 Rust 侧类型定义。
//!
//! 对齐 TS 侧 `src/schema/protocolSchema.ts`：这是「单源真相」在 Rust 侧的映射，
//! `SdkGen` 据此生成 Rust 服务端请求/响应类型与派发骨架。

use std::collections::BTreeMap;

use serde::Deserialize;

/// 字段类型（对齐 TS `FieldType`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Object,
    Array,
}

impl FieldType {
    /// Rust 侧对外的标量类型名。
    pub fn rust_ty(self) -> &'static str {
        match self {
            FieldType::String => "String",
            FieldType::Number => "f64",
            FieldType::Boolean => "bool",
            FieldType::Object => "serde_json::Value",
            FieldType::Array => "Vec<serde_json::Value>",
        }
    }
}

/// 字段 schema（对齐 TS `FieldSchema`）。
#[derive(Debug, Clone, Deserialize)]
pub struct FieldSchema {
    #[serde(rename = "type")]
    pub ty: FieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
}

/// 流式声明（对齐 TS `StreamSchema`）。
#[derive(Debug, Clone, Deserialize)]
pub struct StreamSchema {
    pub event: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// 方法 schema（对齐 TS `MethodSchema`；params/result 为字段名→schema 的有序映射）。
#[derive(Debug, Clone, Deserialize)]
pub struct MethodSchema {
    pub name: String,
    pub description: String,
    pub params: BTreeMap<String, FieldSchema>,
    pub result: BTreeMap<String, FieldSchema>,
    #[serde(default)]
    pub stream: Option<StreamSchema>,
}

/// 协议 schema（对齐 TS `ProtocolSchema`）。
#[derive(Debug, Clone, Deserialize)]
pub struct ProtocolSchema {
    pub jsonrpc: String,
    pub methods: Vec<MethodSchema>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_type_maps_to_rust() {
        assert_eq!(FieldType::String.rust_ty(), "String");
        assert_eq!(FieldType::Number.rust_ty(), "f64");
        assert_eq!(FieldType::Boolean.rust_ty(), "bool");
        assert_eq!(FieldType::Array.rust_ty(), "Vec<serde_json::Value>");
    }

    #[test]
    fn schema_roundtrips_via_json() {
        let json = r#"{
            "jsonrpc": "2.0",
            "methods": [{
                "name": "threads.create",
                "description": "创建线程",
                "params": {"prompt": {"type": "string", "required": true}},
                "result": {"threadId": {"type": "string"}}
            }]
        }"#;
        let schema: ProtocolSchema = serde_json::from_str(json).expect("parse");
        assert_eq!(schema.jsonrpc, "2.0");
        assert_eq!(schema.methods.len(), 1);
        assert_eq!(schema.methods[0].name, "threads.create");
        assert!(schema.methods[0].params.contains_key("prompt"));
        assert_eq!(schema.methods[0].params["prompt"].ty, FieldType::String);
    }
}
