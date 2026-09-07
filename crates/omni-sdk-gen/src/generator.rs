//! 单源 schema → Rust 服务端类型生成器。
//!
//! 对齐 TS 侧 `src/schema/codeGenerator.ts` 的职责：同一份 schema 生成三端。
//! 本模块负责生成 Rust 侧：每个方法一对 `Params`/`Result` 结构体 + 一个 `dispatch`
//! 派发骨架（match 臂），让 Rust 服务端能据此实现 JSON-RPC 处理器。

use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::schema::{FieldSchema, MethodSchema, ProtocolSchema};

/// 由 Rust 标识符片段转合法标识符（方法名 `threads.create` → `ThreadsCreate`）。
fn ident(seg: &str) -> String {
    seg.split('.').map(capitalize).collect::<String>()
}

/// 首字母大写。
fn capitalize(seg: &str) -> String {
    let mut chars = seg.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Rust 字段名：原字段名去首字母大写（`threadId` → `thread_id`）。
fn field_ident(name: &str) -> String {
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// 依据 required 与类型推导字段类型字符串。
fn field_ty(field: &FieldSchema) -> String {
    let base = field.ty.rust_ty();
    if field.required {
        base.to_string()
    } else {
        format!("Option<{base}>")
    }
}

/// 生成器：schema → Rust 服务端类型源码。
pub struct SdkGen;

impl SdkGen {
    /// 生成完整 Rust 源码：结构体 + dispatch 骨架。
    pub fn generate(&self, schema: &ProtocolSchema) -> String {
        let header = format!(
            "//! 由 OmniHarness 单源 protocol schema 自动生成（勿手改）。\n//! jsonrpc: {}，共 {} 个方法。\n\n",
            schema.jsonrpc,
            schema.methods.len()
        );
        let structs = schema
            .methods
            .iter()
            .map(|m| self.gen_structs(m))
            .collect::<Vec<_>>()
            .join("\n");
        let dispatch = self.gen_dispatch(schema);
        format!("{header}{structs}\n{dispatch}")
    }

    /// 为单个方法生成一对 `Params`/`Result` 结构体。
    fn gen_structs(&self, method: &MethodSchema) -> String {
        let name = ident(&method.name);
        let mut params_fields = String::new();
        let mut result_fields = String::new();
        self.write_fields(&mut params_fields, &method.params);
        self.write_fields(&mut result_fields, &method.result);

        let mut out = String::new();
        let _ = write!(
            out,
            "/// {}。\n#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\npub struct {}Params {{\n{}\n}}\n",
            method.description, name, params_fields
        );
        let _ = write!(
            out,
            "/// {} 的响应。\n#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\npub struct {}Result {{\n{}\n}}\n",
            method.description, name, result_fields
        );
        out
    }

    /// 写入结构体字段块。
    fn write_fields(&self, out: &mut String, fields: &BTreeMap<String, FieldSchema>) {
        for (name, field) in fields {
            let ident = field_ident(name);
            let ty = field_ty(field);
            let doc = field
                .description
                .as_deref()
                .map(|d| format!("    /// {d}。\n"))
                .unwrap_or_default();
            let _ = writeln!(out, "{doc}    pub {ident}: {ty},");
        }
    }

    /// 生成 dispatch 派发骨架：match 方法名 → 类型标注 + 未实现占位。
    fn gen_dispatch(&self, schema: &ProtocolSchema) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "/// 按方法名派发到对应类型；处理器需各自实现。\npub fn dispatch(method: &str, raw: &str) -> Result<String, String> {{\n    match method {{"
        );
        for m in &schema.methods {
            let name = ident(&m.name);
            let _ = writeln!(
                out,
                "        \"{m}\" => {{ let params: {name}Params = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!(\"handler for {m} not implemented (got params: {{:?}})\", params)) }}",
                m = m.name
            );
        }
        let _ = writeln!(
            out,
            "        _ => Err(format!(\"unknown method: {{method}}\")),\n    }}\n}}"
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::FieldType;

    fn field(name: &str, ty: FieldType, required: bool) -> (String, FieldSchema) {
        (
            name.to_string(),
            FieldSchema {
                ty,
                required,
                description: None,
            },
        )
    }

    fn fields(list: &[(String, FieldSchema)]) -> BTreeMap<String, FieldSchema> {
        list.iter().cloned().collect()
    }

    fn mini_schema() -> ProtocolSchema {
        ProtocolSchema {
            jsonrpc: "2.0".into(),
            methods: vec![MethodSchema {
                name: "threads.create".into(),
                description: "创建线程并执行任务".into(),
                params: fields(&[field("prompt", FieldType::String, true)]),
                result: fields(&[
                    field("threadId", FieldType::String, false),
                    field("steps", FieldType::Number, false),
                ]),
                stream: None,
            }],
        }
    }

    #[test]
    fn camel_to_snake_field() {
        assert_eq!(field_ident("threadId"), "thread_id");
        assert_eq!(field_ident("finalText"), "final_text");
        assert_eq!(field_ident("prompt"), "prompt");
    }

    #[test]
    fn dotted_method_to_type_ident() {
        assert_eq!(ident("threads.create"), "ThreadsCreate");
        assert_eq!(ident("approval.respond"), "ApprovalRespond");
    }

    #[test]
    fn generate_produces_params_and_result_structs() {
        let code = SdkGen.generate(&mini_schema());
        assert!(code.contains("pub struct ThreadsCreateParams {"));
        assert!(code.contains("pub prompt: String,"));
        assert!(code.contains("pub struct ThreadsCreateResult {"));
        assert!(code.contains("pub thread_id: Option<String>,"));
        assert!(code.contains("pub steps: Option<f64>,"));
    }

    #[test]
    fn generate_produces_dispatch_skeleton() {
        let code = SdkGen.generate(&mini_schema());
        assert!(code.contains("pub fn dispatch(method: &str, raw: &str)"));
        assert!(code.contains("\"threads.create\" =>"));
        assert!(code.contains("unknown method"));
    }
}
