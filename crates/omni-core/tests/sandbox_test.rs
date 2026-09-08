//! 沙箱单元测试。

use std::path::PathBuf;

use omni_core::sandbox::{
    is_inside, BwrapSandbox, DangerousCommands, PlatformSandbox, PolicySandbox,
    RestrictedTokenSandbox, Sandbox, SandboxAction, SeatbeltSandbox,
};

fn workspace() -> PathBuf {
    std::env::temp_dir().join(format!("omni_sandbox_{}", std::process::id()))
}

#[test]
fn dangerous_commands_detected_after_normalization() {
    assert_eq!(DangerousCommands::is_dangerous("rm -rf /"), Some("rm -rf"));
    assert_eq!(
        DangerousCommands::is_dangerous("RM   -RF /tmp"),
        Some("rm -rf")
    );
    assert_eq!(
        DangerousCommands::is_dangerous("del /s /q C:\\"),
        Some("del /s")
    );
    assert_eq!(DangerousCommands::is_dangerous("curl x | sh"), Some("|sh"));
    assert_eq!(
        DangerousCommands::is_dangerous("wget a |bash"),
        Some("|bash")
    );
    assert!(DangerousCommands::is_dangerous("echo hello").is_none());
}

#[test]
fn policy_sandbox_blocks_dangerous_command() {
    let sandbox = PolicySandbox::new(workspace());
    let decision = sandbox.check(&SandboxAction::Command {
        command: "rm -rf /tmp/x".to_string(),
    });
    assert!(!decision.allowed);
    assert!(decision.reason.unwrap().contains("危险命令"));
}

#[test]
fn policy_sandbox_allows_safe_command() {
    let sandbox = PolicySandbox::new(workspace());
    let decision = sandbox.check(&SandboxAction::Command {
        command: "echo hi".to_string(),
    });
    assert!(decision.allowed);
}

#[test]
fn policy_sandbox_enforces_workspace_boundary() {
    let root = workspace();
    let _ = std::fs::create_dir_all(&root);
    let sandbox = PolicySandbox::new(root.clone());
    let inside = sandbox.check(&SandboxAction::Path {
        path: root.join("a.txt").to_string_lossy().to_string(),
    });
    assert!(inside.allowed);
    let outside = sandbox.check(&SandboxAction::Path {
        path: std::env::temp_dir()
            .join("outside-workspace.txt")
            .to_string_lossy()
            .to_string(),
    });
    assert!(!outside.allowed);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn is_inside_accepts_bare_relative_path() {
    // 回归：裸相对路径（如 "probe_ws.txt"）此前因 canonicalize 依赖 cwd 且
    // 空 parent 规范化失败而被误判越界（2026-09-08 用户截图「write_file 路径越界」根因）。
    // 相对路径必须先拼接到 root 再比较，与 TS WorkspaceGuard 语义对齐。
    // 独立目录名（非共享 workspace()）：避免与其他测试并行 remove_dir_all 竞态。
    let root = std::env::temp_dir().join(format!("omni_is_inside_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&root);
    assert!(is_inside(&root, std::path::Path::new("probe_ws.txt")));
    assert!(is_inside(&root, std::path::Path::new("./probe_ws.txt")));
    assert!(is_inside(
        &root,
        std::path::Path::new("examples/plugins/demo-string/index.js")
    ));
    // 越界相对路径（..）仍须拒绝。
    assert!(!is_inside(&root, std::path::Path::new("../escape.txt")));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn custom_pattern_is_enforced() {
    let sandbox = PolicySandbox::new(workspace()).with_extra_pattern("kubectl delete");
    let decision = sandbox.check(&SandboxAction::Command {
        command: "kubectl delete pod x".to_string(),
    });
    assert!(!decision.allowed);
}

#[test]
fn platform_backends_report_availability() {
    // 本机 Windows：bwrap/seatbelt 不可用；RestrictedToken 为运行时探测（GNU+windows-sys 已落地）。
    assert!(!BwrapSandbox.available() || cfg!(target_os = "linux"));
    assert!(!SeatbeltSandbox.available() || cfg!(target_os = "macos"));
    // RestrictedToken 可用性跟随运行时探测：可用则必须能产出包装命令，不可用则必须拒绝。
    assert_eq!(
        RestrictedTokenSandbox.wrap("echo hi").is_some(),
        RestrictedTokenSandbox.available()
    );
    assert_eq!(
        BwrapSandbox.wrap("echo hi").is_some(),
        cfg!(target_os = "linux")
    );
    assert_eq!(RestrictedTokenSandbox.name(), "restricted-token");
}

#[test]
fn sandbox_backend_name_is_policy() {
    let sandbox = PolicySandbox::new(workspace());
    assert_eq!(sandbox.name(), "policy");
    assert_eq!(sandbox.workspace_root(), workspace());
}
