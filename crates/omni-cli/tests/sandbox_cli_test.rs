//! omni-cli `sandbox` 子命令集成测试：
//! - check 输出结构化 JSON 且 ok=true；
//! - run 以受限令牌 + Job Object 启动命令并透传退出码（Windows 真实受限进程）。

use std::process::Command;

/// check：探测受限进程能力（Windows 上真实调用系统 API）。
#[test]
fn cli_sandbox_check_reports_json() {
    let exe = env!("CARGO_BIN_EXE_omni-cli");
    let out = Command::new(exe)
        .args(["sandbox", "check"])
        .output()
        .expect("sandbox check 应可执行");
    assert!(out.status.success(), "check 应成功: {:?}", out);
    let text = String::from_utf8_lossy(&out.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).expect("输出应为合法 JSON");
    assert_eq!(value["ok"], serde_json::json!(true));
    assert_eq!(value["name"], serde_json::json!("restricted-token"));
}

/// run：受限进程退出码透传（Windows；能力不可用时自动跳过）。
#[cfg(windows)]
#[test]
fn cli_sandbox_run_passthroughs_exit_code() {
    let exe = env!("CARGO_BIN_EXE_omni-cli");
    let check = Command::new(exe)
        .args(["sandbox", "check"])
        .output()
        .expect("sandbox check 应可执行");
    let value: serde_json::Value =
        serde_json::from_slice(&check.stdout).expect("check 输出应为 JSON");
    if value["available"] != serde_json::json!(true) {
        eprintln!("受限进程能力不可用，跳过");
        return;
    }

    let out = Command::new(exe)
        .args(["sandbox", "run", "--command", "cmd /c exit 42"])
        .output()
        .expect("sandbox run 应可执行");
    assert_eq!(
        out.status.code(),
        Some(42),
        "受限进程退出码应透传: {:?}",
        String::from_utf8_lossy(&out.stderr)
    );
}
