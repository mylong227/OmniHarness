//! 集成测试：读真实 schema fixture → 生成 Rust 代码 → 断言关键结构。
//! 校验生成器对完整协议 schema（7 方法，含 threads.rewind）的产出符合单源 schema 语义。

use omni_sdk_gen::{ProtocolSchema, SdkGen};

fn load_schema() -> ProtocolSchema {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/protocolSchema.json");
    let text = std::fs::read_to_string(path).expect("read fixture");
    serde_json::from_str(&text).expect("parse schema")
}

#[test]
fn generates_every_method_as_struct_pairs() {
    let code = SdkGen.generate(&load_schema());
    // 每个方法一对 Params/Result 结构体（与单源 schema 的方法数一致）
    for name in [
        "ThreadsCreate",
        "ThreadsContinue",
        "ThreadsFork",
        "ThreadsGet",
        "ThreadsRewind",
        "TurnsRun",
        "ApprovalRespond",
    ] {
        assert!(
            code.contains(&format!("pub struct {name}Params {{")),
            "missing {name}Params"
        );
        assert!(
            code.contains(&format!("pub struct {name}Result {{")),
            "missing {name}Result"
        );
    }
}

#[test]
fn maps_optional_and_required_correctly() {
    let code = SdkGen.generate(&load_schema());
    // approval.respond 的 decision 必填 → String；threads.get 的 items 可选 → Option<Vec<...>>
    assert!(code.contains("pub struct ApprovalRespondParams {"));
    assert!(code.contains("pub request_id: String,"));
    assert!(code.contains("pub decision: String,"));
    // threads.get result items 为 array 且非必填
    assert!(code.contains("pub items: Option<Vec<serde_json::Value>>,"));
}

#[test]
fn dispatch_covers_every_method_and_unknown() {
    let code = SdkGen.generate(&load_schema());
    assert!(code.contains("pub fn dispatch(method: &str, raw: &str)"));
    for m in [
        "threads.create",
        "threads.continue",
        "threads.fork",
        "threads.get",
        "threads.rewind",
        "turns.run",
        "approval.respond",
    ] {
        assert!(
            code.contains(&format!("\"{m}\" =>")),
            "missing dispatch arm {m}"
        );
    }
    assert!(code.contains("unknown method"));
}

#[test]
fn generated_source_roundtrips_names() {
    let code = SdkGen.generate(&load_schema());
    // 字段 camelCase → snake_case：finalText → final_text, threadId → thread_id, requestId → request_id
    assert!(code.contains("pub final_text:"));
    assert!(code.contains("pub thread_id:"));
    assert!(code.contains("pub request_id:"));
    // 不应残留原驼峰
    assert!(!code.contains("pub finalText"));
    assert!(!code.contains("pub requestId"));
}
