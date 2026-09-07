//! omni-sdk-gen CLI：`omni-sdk-gen generate <schema.json>` 读 schema 输出 Rust 服务端类型源码。
//!
//! 无 schema 参数时使用内置的最小示例 schema（对齐 TS `protocolSchema` 的前两个方法）。

use std::fs;

use omni_sdk_gen::{ProtocolSchema, SdkGen};

const USAGE: &str = "用法: omni-sdk-gen generate [schema.json]";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || args[1] != "generate" {
        eprintln!("{USAGE}");
        std::process::exit(2);
    }

    let schema = if args.len() >= 3 {
        let text = fs::read_to_string(&args[2]).unwrap_or_else(|e| {
            eprintln!("读取 schema 失败: {e}");
            std::process::exit(1);
        });
        serde_json::from_str::<ProtocolSchema>(&text).unwrap_or_else(|e| {
            eprintln!("解析 schema 失败: {e}");
            std::process::exit(1);
        })
    } else {
        sample_schema()
    };

    print!("{}", SdkGen.generate(&schema));
}

/// 内置示例 schema：对齐 TS `protocolSchema` 的 threads.create / threads.get 两个方法。
fn sample_schema() -> ProtocolSchema {
    use omni_sdk_gen::FieldType;
    use std::collections::BTreeMap;
    let field = |name: &str, ty: FieldType, required: bool| {
        (
            name.to_string(),
            omni_sdk_gen::FieldSchema {
                ty,
                required,
                description: None,
            },
        )
    };
    let fields = |list: Vec<(String, omni_sdk_gen::FieldSchema)>| {
        list.into_iter().collect::<BTreeMap<_, _>>()
    };
    ProtocolSchema {
        jsonrpc: "2.0".into(),
        methods: vec![
            omni_sdk_gen::MethodSchema {
                name: "threads.create".into(),
                description: "创建线程并执行任务".into(),
                params: fields(vec![field("prompt", FieldType::String, true)]),
                result: fields(vec![
                    field("threadId", FieldType::String, false),
                    field("finalText", FieldType::String, false),
                    field("steps", FieldType::Number, false),
                ]),
                stream: None,
            },
            omni_sdk_gen::MethodSchema {
                name: "threads.get".into(),
                description: "获取线程事件".into(),
                params: fields(vec![field("threadId", FieldType::String, true)]),
                result: fields(vec![
                    field("threadId", FieldType::String, false),
                    field("items", FieldType::Array, false),
                ]),
                stream: None,
            },
        ],
    }
}
