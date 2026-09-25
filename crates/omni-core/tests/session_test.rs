//! Session 状态机端到端单元测试。

use std::sync::{Arc, Mutex};

use omni_core::approval::RuleDecision;
use omni_core::context::{ContextManager, TruncateSummarizer};
use omni_core::queue::{Op, Submission};
// RestrictedTokenSandbox 仅 Windows 有真实实现（非 Windows 返回不可用，用例内自行跳过）；
// 导入同样按平台门控——否则 Linux 上 unused import，clippy -D warnings 阻断（ubuntu 首跑实证）。
#[cfg(windows)]
use omni_core::sandbox::RestrictedTokenSandbox;
use omni_core::session::Session;
use omni_core::PlatformSandbox;

fn workspace() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("omni_session_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 记录 wrap 调用的 OS 沙箱替身：把命令包装为 `echo wrapped:<cmd>`。
struct RecordingSandbox(Arc<Mutex<Vec<String>>>);

impl PlatformSandbox for RecordingSandbox {
    fn name(&self) -> &str {
        "recording"
    }
    fn available(&self) -> bool {
        true
    }
    fn wrap(&self, command: &str) -> Option<String> {
        self.0.lock().unwrap().push(command.to_string());
        Some(format!("echo wrapped:{}", command))
    }
}

#[test]
fn user_input_opens_and_closes_turn() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::UserInput {
        text: "你好".to_string(),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    assert!(matches!(ops.first(), Some(Op::TurnStarted)));
    assert!(matches!(ops.last(), Some(Op::TurnCompleted)));
}

#[test]
fn tool_call_runs_through_full_gate_chain() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::ToolCall {
        call_id: "c1".to_string(),
        name: "math.eval".to_string(),
        args: serde_json::json!({ "expression": "6*7" }),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    assert!(ops
        .iter()
        .any(|op| matches!(op, Op::ToolCall { call_id, .. } if call_id == "c1")));
    assert!(ops.iter().any(|op| matches!(op, Op::ToolResult { call_id, ok: true, output } if call_id == "c1" && output == "42")));
    assert!(!session.events().is_empty());
}

#[test]
fn denied_tool_call_is_rejected_and_logged() {
    let mut session = Session::new("s1");
    session.submit(Submission::ToolCall {
        call_id: "c2".to_string(),
        name: "anything".to_string(),
        args: serde_json::json!({}),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    assert!(ops
        .iter()
        .any(|op| matches!(op, Op::ToolResult { ok: false, .. })));
    assert!(ops.iter().any(|op| matches!(op, Op::Error { .. })));
}

#[test]
fn dangerous_command_blocked_by_sandbox() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::ToolCall {
        call_id: "c3".to_string(),
        name: "shell".to_string(),
        args: serde_json::json!({ "command": "rm -rf /tmp/x" }),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    match ops.iter().find(|op| matches!(op, Op::ToolResult { .. })) {
        Some(Op::ToolResult { ok, output, .. }) => {
            assert!(!*ok);
            assert!(output.contains("危险命令"));
        }
        other => panic!("应产出拒绝结果，实际 {:?}", other),
    }
}

#[test]
fn ask_decision_suspends_until_approval_reply() {
    let mut session = Session::standard("s1", workspace());
    session
        .approval_mut()
        .add_prefix_rule("git push", RuleDecision::Ask);
    session.submit(Submission::ToolCall {
        call_id: "c4".to_string(),
        name: "shell".to_string(),
        args: serde_json::json!({ "command": "git push origin main" }),
    });
    session.run_until_idle();
    assert!(session
        .drain_ops()
        .iter()
        .any(|op| matches!(op, Op::ApprovalRequired { call_id, .. } if call_id == "c4")));

    // 人工放行：补发裁决后进入执行（仍是 shell 工具未注册 → fail-closed 拒绝）。
    session.submit(Submission::ApprovalReply {
        call_id: "c4".to_string(),
        approved: true,
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    assert!(ops
        .iter()
        .any(|op| matches!(op, Op::ToolResult { call_id, .. } if call_id == "c4")));
}

#[test]
fn approval_reply_for_unknown_call_reports_error() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::ApprovalReply {
        call_id: "ghost".to_string(),
        approved: true,
    });
    session.run_until_idle();
    assert!(session
        .drain_ops()
        .iter()
        .any(|op| matches!(op, Op::Error { message } if message.contains("无待裁决调用"))));
}

#[test]
fn reasoning_is_recorded_and_survives_compaction() {
    let mut session = Session::new("s1");
    session.context_mut().push_reasoning("推理：先验证再执行");
    session.submit(Submission::Reasoning {
        text: "推理：失败即回退".to_string(),
    });
    session.run_until_idle();
    assert_eq!(session.context().reasoning_summaries().len(), 2);
    assert!(session.render_context().contains("推理：先验证再执行"));
}

#[test]
fn compaction_triggers_when_over_budget() {
    let mut session = Session::standard("s1", workspace());
    // 小预算 + 短摘要：10 轮长历史折叠后 token 显著下降。
    *session.context_mut() = ContextManager::new(50)
        .with_keep_recent(2)
        .with_summarizer(Box::new(TruncateSummarizer::new(40)));
    for i in 0..10 {
        session.submit(Submission::UserInput {
            text: format!(
                "第{}轮：{}",
                i,
                "这是一段足够长的中文内容用于累积上下文".repeat(3)
            ),
        });
    }
    session.run_until_idle();
    let ops = session.drain_ops();
    let compacted: Vec<(usize, usize)> = ops
        .iter()
        .filter_map(|op| match op {
            Op::Compacted {
                before_tokens,
                after_tokens,
            } => Some((*before_tokens, *after_tokens)),
            _ => None,
        })
        .collect();
    assert!(!compacted.is_empty(), "应产出压缩事件");
    // 首轮折叠时历史不足 keep_recent，压缩前后相等；累积后必有真实降幅。
    assert!(
        compacted.iter().any(|(before, after)| after < before),
        "压缩应产生 token 降幅，实际 {:?}",
        compacted
    );
}

#[test]
fn manual_compact_submission_emits_compacted_op() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::Compact);
    session.run_until_idle();
    assert!(session
        .drain_ops()
        .iter()
        .any(|op| matches!(op, Op::Compacted { .. })));
}

#[test]
fn interrupt_closes_turn_and_drops_queue() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::UserInput {
        text: "开始".to_string(),
    });
    session.submit(Submission::Interrupt);
    session.run_until_idle();
    let ops = session.drain_ops();
    assert!(matches!(ops.last(), Some(Op::TurnCompleted)));
}

#[test]
fn shutdown_marks_session_not_alive() {
    let mut session = Session::standard("s1", workspace());
    session.submit(Submission::Shutdown);
    session.run_until_idle();
    assert!(!session.is_alive());
    assert!(session
        .drain_ops()
        .iter()
        .any(|op| matches!(op, Op::Shutdown)));
}

#[test]
fn session_id_is_exposed() {
    let session = Session::standard("session-x", workspace());
    assert_eq!(session.id(), "session-x");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn os_sandbox_wraps_command_tool() {
    // 命令类工具 + OS 沙箱可用：命令应被包装后再执行，原始命令交给 OS 后端。
    let mut session = Session::standard("s1", workspace());
    let calls = Arc::new(Mutex::new(Vec::new()));
    session.set_os_sandbox(Box::new(RecordingSandbox(calls.clone())));
    session.submit(Submission::ToolCall {
        call_id: "os1".to_string(),
        name: "shell.run".to_string(),
        args: serde_json::json!({ "command": "echo hi" }),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    let result = ops
        .iter()
        .find_map(|op| match op {
            Op::ToolResult {
                call_id,
                ok,
                output,
            } if call_id == "os1" => Some((*ok, output.clone())),
            _ => None,
        })
        .expect("应产出工具结果");
    assert!(result.0, "包装后的命令应执行成功: {:?}", result.1);
    assert!(
        result.1.contains("wrapped"),
        "输出应含包装痕迹: {:?}",
        result.1
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["echo hi".to_string()],
        "原始命令应原样交给 OS 沙箱"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn os_sandbox_failure_rejects_execution() {
    // OS 沙箱可用但包装失败：fail-closed 拒绝执行。
    struct FailingSandbox;
    impl PlatformSandbox for FailingSandbox {
        fn name(&self) -> &str {
            "failing"
        }
        fn available(&self) -> bool {
            true
        }
        fn wrap(&self, _command: &str) -> Option<String> {
            None
        }
    }

    let mut session = Session::standard("s1", workspace());
    session.set_os_sandbox(Box::new(FailingSandbox));
    session.submit(Submission::ToolCall {
        call_id: "os2".to_string(),
        name: "shell.run".to_string(),
        args: serde_json::json!({ "command": "echo hi" }),
    });
    session.run_until_idle();
    let ops = session.drain_ops();
    let result = ops
        .iter()
        .find_map(|op| match op {
            Op::ToolResult {
                call_id,
                ok,
                output,
            } if call_id == "os2" => Some((*ok, output.clone())),
            _ => None,
        })
        .expect("应产出工具结果");
    assert!(!result.0, "包装失败应拒绝执行");
    assert!(
        result.1.contains("包装失败"),
        "拒绝理由应含包装失败: {:?}",
        result.1
    );
}

// ============================================================
// #72 真实 OS 沙箱回路回归：锁死 GBK 解码 + 含空格多参保全 + 策略沙箱优先
// ============================================================

/// 把 cargo 构建目录（<workspace>/target/{debug,release}）注入 PATH，
/// 使 run_shell 能找到 omni-cli 以拉起受限进程。
#[cfg(windows)]
fn ensure_omni_cli_on_path() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let workspace = std::path::Path::new(&manifest)
        .parent()
        .and_then(|p| p.parent());
    if let Some(ws) = workspace {
        let mut extra = Vec::new();
        for profile in ["debug", "release"] {
            let bin = ws.join("target").join(profile);
            if bin.exists() {
                extra.push(bin.display().to_string());
            }
        }
        if !extra.is_empty() {
            let existing = std::env::var("PATH").unwrap_or_default();
            std::env::set_var("PATH", format!("{};{}", extra.join(";"), existing));
        }
    }
}

#[cfg(windows)]
fn omni_cli_present() -> bool {
    for dir in std::env::var("PATH").unwrap_or_default().split(';') {
        if std::path::Path::new(dir).join("omni-cli.exe").exists() {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn first_tool_result(ops: &[Op], call_id: &str) -> (bool, String) {
    for op in ops {
        if let Op::ToolResult {
            call_id: c,
            ok,
            output,
        } = op
        {
            if c == call_id {
                return (*ok, output.clone());
            }
        }
    }
    panic!("未找到 call_id={} 的工具结果", call_id);
}

/// #72 修复点回归：shell.run 经真实 RestrictedToken OS 沙箱执行时，
/// 必须 ① 还原 GBK 中文输出、② 保全含空格多参命令、③ 危险命令仍被策略沙箱挡在 OS 包装之前。
/// 仅在 RestrictedToken 沙箱可用 + omni-cli 存在时运行；否则跳过（CI 无 omni-cli 不强制）。
#[cfg(windows)]
#[test]
fn shell_run_through_real_os_sandbox_preserves_cjk_and_args() {
    use omni_core::PlatformSandbox;
    if !RestrictedTokenSandbox.available() {
        eprintln!("RestrictedToken 沙箱不可用，跳过真实 OS 沙箱回路测试");
        return;
    }
    ensure_omni_cli_on_path();
    if !omni_cli_present() {
        eprintln!("omni-cli 不在 PATH/构建目录，跳过真实 OS 沙箱回路测试");
        return;
    }

    // ① GBK 中文输出解码还原（#72 修复点：decode_output 用 CP_OEMCP）。
    let mut s = Session::standard("s1", workspace());
    s.submit(Submission::ToolCall {
        call_id: "cjk".to_string(),
        name: "shell.run".to_string(),
        args: serde_json::json!({ "command": "echo 中文测试输出" }),
    });
    s.run_until_idle();
    let (ok, out) = first_tool_result(&s.drain_ops(), "cjk");
    assert!(ok, "CJK echo 应执行成功: {:?}", out);
    assert!(
        out.contains("中文测试输出"),
        "GBK 解码应还原中文，实际输出: {:?}",
        out
    );

    // ② 含空格多参命令：不得因 cmd /C 二次转义丢参（#72 修复点：argv 直调 omni-cli）。
    let mut s = Session::standard("s2", workspace());
    s.submit(Submission::ToolCall {
        call_id: "args".to_string(),
        name: "shell.run".to_string(),
        args: serde_json::json!({ "command": "echo 多 参 数 命 令" }),
    });
    s.run_until_idle();
    let (ok, out) = first_tool_result(&s.drain_ops(), "args");
    assert!(ok, "多参 echo 应执行成功: {:?}", out);
    assert_eq!(
        out, "多 参 数 命 令",
        "含空格命令参数应保全，不应只剩首词，实际: {:?}",
        out
    );

    // ③ 危险命令仍被策略沙箱挡在 OS 包装之前（#72 未改此行为，锁死不回归）。
    let mut s = Session::standard("s3", workspace());
    s.submit(Submission::ToolCall {
        call_id: "danger".to_string(),
        name: "shell.run".to_string(),
        args: serde_json::json!({ "command": "rm -rf C:\\Windows\\Temp\\x" }),
    });
    s.run_until_idle();
    let (ok, out) = first_tool_result(&s.drain_ops(), "danger");
    assert!(!ok, "危险命令应被策略沙箱拒绝");
    assert!(
        out.contains("危险命令"),
        "拒绝理由应含危险命令，实际: {:?}",
        out
    );
}
