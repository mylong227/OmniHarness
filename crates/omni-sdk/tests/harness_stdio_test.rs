//! 跨语言集成测试：Rust SDK 经 stdio 调用运行中的 TS app-server（`omniharness server`）。
//! 依赖 TS 构建产物 `dist/src/cli/exec.js`；产物缺失时自动跳过（不算失败）。

use std::path::PathBuf;

use omni_sdk::{ChildProcessTransport, OmniClient};

/// 定位 TS CLI 产物（相对 workspace 根）。
fn ts_cli_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dist")
        .join("src")
        .join("cli")
        .join("exec.js")
}

/// 启动 TS app-server（mock 模型，避免依赖真实 API）。
fn spawn_harness() -> Option<OmniClient<ChildProcessTransport>> {
    let entry = ts_cli_entry();
    if !entry.exists() {
        eprintln!("[skip] TS 产物缺失: {}", entry.display());
        return None;
    }
    let entry_str = entry.to_string_lossy().to_string();
    let transport = ChildProcessTransport::spawn(
        "node",
        &[entry_str.as_str(), "server", "--model-adapter", "mock"],
    )
    .ok()?;
    Some(OmniClient::new(transport))
}

#[test]
fn rust_sdk_drives_live_ts_app_server() {
    let Some(mut client) = spawn_harness() else {
        return;
    };
    let result = client
        .request(
            "threads.create",
            serde_json::json!({ "prompt": "Rust SDK 联调" }),
        )
        .expect("threads.create 成功");
    let thread_id = result["threadId"].as_str().unwrap_or("").to_string();
    assert!(!thread_id.is_empty(), "应返回 threadId，实际 {}", result);
    assert_eq!(result["finalText"], "任务完成（模拟模型适配器输出）");
}

#[test]
fn rust_sdk_runs_turn_on_live_server() {
    let Some(mut client) = spawn_harness() else {
        return;
    };
    let result = client
        .request("turns.run", serde_json::json!({ "prompt": "跑一个回合" }))
        .expect("turns.run 成功");
    assert!(result["steps"].as_u64().unwrap_or(0) > 0);
}

#[test]
fn unknown_method_is_rejected_by_server() {
    let Some(mut client) = spawn_harness() else {
        return;
    };
    let error = client
        .request("does.not.exist", serde_json::json!({}))
        .expect_err("未知方法应返回错误");
    assert!(matches!(error, omni_sdk::RpcError::Remote { .. }));
}
