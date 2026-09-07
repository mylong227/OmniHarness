//! omni CLI 入口（一个子命令一个函数）：
//! - `omni exec "<text>"`   走 agent loop 执行内置 echo 工具，输出结构化 JSON 事件流；
//! - `omni tools`           列出内核内置工具元数据（ToolSpec 自省）；
//! - `omni run '<submission-json>'`   走 Session 状态机（SQ/EQ），输出 Op JSON 流；
//! - `omni approval '<args-json>' --name <tool>`  审批裁决（allow/deny/ask）；
//! - `omni context "<text>" [--budget N]`        上下文压缩演示，输出 token 前后对比；
//! - `omni sdk --addr host:port --method <m> [--params '<json>']`  经 Rust SDK 调用运行中的 harness；
//! - `omni sandbox check|run --command "<cmd>"`  受限进程能力探测 / 受限启动。

mod sandbox_cmd;

use std::process::ExitCode;

use omni_core::context::{ContextManager, TruncateSummarizer};
use omni_core::queue::{Op, Submission};
use omni_core::{AgentLoop, ApprovalEngine, EchoTool, RuleDecision, Session};
use omni_sdk::{ChildProcessTransport, OmniClient, TcpTransport};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();

    match args.get(1).map(String::as_str) {
        Some("exec") if args.len() >= 3 => exec(&args[2]),
        Some("tools") => tools(),
        Some("run") if args.len() >= 3 => run(&args[2]),
        Some("approval") if args.len() >= 3 => approval(&args[2], &args[2..]),
        Some("context") if args.len() >= 3 => context(&args[2], &args[2..]),
        Some("sdk") => sdk(&args[2..]),
        Some("sandbox") => sandbox_cmd::dispatch(&args[2..]),
        _ => usage(),
    }
}

/// 用法提示。
fn usage() -> ExitCode {
    eprintln!("用法:");
    eprintln!("  omni exec \"<text>\"");
    eprintln!("  omni tools");
    eprintln!("  omni run '<submission-json>'");
    eprintln!("  omni approval '<args-json>' --name <tool>");
    eprintln!("  omni context \"<text>\" [--budget N]");
    eprintln!("  omni sdk --addr host:port --method <m> [--params '<json>']");
    eprintln!("  omni sandbox check");
    eprintln!("  omni sandbox run --command \"<cmd>\"");
    ExitCode::from(2)
}

/// 执行一次内置 echo 工具调用。
fn exec(text: &str) -> ExitCode {
    let mut loop_ = AgentLoop::new();
    loop_.register(Box::new(EchoTool));

    let (call_evt, result_evt) = loop_.run_tool(
        "session-1",
        "call-1",
        "echo",
        serde_json::json!({ "text": text }),
    );

    // 输出结构化 JSON（每行一条事件），对应蓝图 M0 验收。
    println!("{}", call_evt.to_json());
    println!("{}", result_evt.to_json());

    let ok = result_evt
        .payload
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if ok {
        println!(
            "{{\"ok\":true,\"output\":{}}}",
            serde_json::json!(result_evt.payload.get("output"))
        );
        ExitCode::SUCCESS
    } else {
        eprintln!("{{ \"ok\": false, \"error\": \"工具执行失败\" }}");
        ExitCode::from(1)
    }
}

/// 列出内核内置工具元数据。
fn tools() -> ExitCode {
    let mut loop_ = AgentLoop::new();
    loop_.register_builtins(std::env::current_dir().unwrap_or_default());
    let metas = loop_.list_tools();
    println!(
        "{}",
        serde_json::to_string_pretty(&metas).unwrap_or_default()
    );
    ExitCode::SUCCESS
}

/// 走 Session 状态机处理一条 Submission，输出 Op JSON 流。
fn run(submission_json: &str) -> ExitCode {
    let submission: Submission = match serde_json::from_str(submission_json) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{{ \"ok\": false, \"error\": \"非法 submission: {}\" }}", e);
            return ExitCode::from(1);
        }
    };
    let root = std::env::current_dir().unwrap_or_default();
    let mut session = Session::standard("cli-session", root);
    session.submit(submission);
    session.run_until_idle();
    for op in session.drain_ops() {
        println!("{}", op.to_json());
    }
    ExitCode::SUCCESS
}

/// 审批裁决：默认拒绝，未知工具名即被拦（fail-closed）。
fn approval(args_json: &str, rest: &[String]) -> ExitCode {
    let name = flag_value(rest, "--name").unwrap_or_else(|| "shell".to_string());
    let args: serde_json::Value = serde_json::from_str(args_json).unwrap_or(serde_json::json!({}));
    let mut engine = ApprovalEngine::deny_all();
    engine.add_tool_rule("echo", RuleDecision::Allow);
    engine.add_tool_rule("now", RuleDecision::Allow);
    engine.add_tool_rule("math.eval", RuleDecision::Allow);
    engine.add_prefix_rule("git status", RuleDecision::Allow);
    engine.add_prefix_rule("git push", RuleDecision::Ask);
    let decision = engine.evaluate(&name, &args);
    println!(
        "{}",
        serde_json::json!({ "ok": true, "name": name, "decision": decision })
    );
    ExitCode::SUCCESS
}

/// 上下文压缩演示：注入文本后压缩，输出 token 前后对比。
fn context(text: &str, rest: &[String]) -> ExitCode {
    let budget = flag_value(rest, "--budget")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(64);
    let mut manager = ContextManager::new(budget)
        .with_keep_recent(2)
        .with_summarizer(Box::new(TruncateSummarizer::new(80)));
    manager.add_fragment(
        "developer_instructions",
        "你是 OmniHarness 内核的编码助手。",
    );
    // 灌入 8 轮历史，触发压缩。
    for i in 0..8 {
        manager.push_turn("user", format!("第{}轮：{}", i, text));
    }
    let before = manager.estimate_tokens();
    let (_, after) = manager.compact();
    println!(
        "{}",
        serde_json::json!({
            "ok": true,
            "budget": budget,
            "beforeTokens": before,
            "afterTokens": after,
            "summary": manager.summary(),
        })
    );
    ExitCode::SUCCESS
}

/// 经 Rust SDK 调用运行中的 harness：
/// - `--addr host:port` 走 TCP；
/// - `--stdio --cmd <program> --cmd-args "<args>"` 走子进程 stdio（如 `omniharness server`）。
fn sdk(rest: &[String]) -> ExitCode {
    let Some(method) = flag_value(rest, "--method") else {
        eprintln!("{{ \"ok\": false, \"error\": \"缺少 --method\" }}");
        return ExitCode::from(1);
    };
    let params = match parse_params(rest) {
        Ok(p) => p,
        Err(code) => return code,
    };

    if flag_value(rest, "--stdio").is_some() {
        let program = flag_value(rest, "--cmd").unwrap_or_else(|| "node".to_string());
        let raw_args = flag_value(rest, "--cmd-args").unwrap_or_default();
        let args: Vec<&str> = raw_args.split_whitespace().collect();
        return sdk_stdio(&program, &args, &method, params);
    }

    let Some(addr) = flag_value(rest, "--addr") else {
        eprintln!("{{ \"ok\": false, \"error\": \"缺少 --addr（或改用 --stdio）\" }}");
        return ExitCode::from(1);
    };
    sdk_tcp(&addr, &method, params)
}

/// 解析 `--params '<json>'`（缺省为空对象）。
fn parse_params(rest: &[String]) -> Result<serde_json::Value, ExitCode> {
    match flag_value(rest, "--params") {
        Some(raw) => match serde_json::from_str(&raw) {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("{{ \"ok\": false, \"error\": \"非法 params: {}\" }}", e);
                Err(ExitCode::from(1))
            }
        },
        None => Ok(serde_json::json!({})),
    }
}

/// 走 TCP 调用。
fn sdk_tcp(addr: &str, method: &str, params: serde_json::Value) -> ExitCode {
    match TcpTransport::connect(addr) {
        Ok(transport) => call_and_print(OmniClient::new(transport), method, params),
        Err(e) => {
            eprintln!("{{ \"ok\": false, \"error\": \"连接失败: {}\" }}", e);
            ExitCode::from(1)
        }
    }
}

/// 走子进程 stdio 调用。
fn sdk_stdio(program: &str, args: &[&str], method: &str, params: serde_json::Value) -> ExitCode {
    match ChildProcessTransport::spawn(program, args) {
        Ok(transport) => call_and_print(OmniClient::new(transport), method, params),
        Err(e) => {
            eprintln!("{{ \"ok\": false, \"error\": \"启动失败: {}\" }}", e);
            ExitCode::from(1)
        }
    }
}

/// 发起一次请求并输出结果 JSON。
fn call_and_print<T: omni_sdk::Transport>(
    mut client: OmniClient<T>,
    method: &str,
    params: serde_json::Value,
) -> ExitCode {
    match client.request(method, params) {
        Ok(result) => {
            println!("{}", serde_json::json!({ "ok": true, "result": result }));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{{ \"ok\": false, \"error\": \"{}\" }}", e);
            ExitCode::from(1)
        }
    }
}

/// 从参数切片取 `--flag value` 的值。
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

/// 保留 Op 的类型引用（编译期确保执行链产出类型未漂移）。
#[allow(dead_code)]
fn assert_op_shape(op: &Op) -> bool {
    matches!(op, Op::ToolResult { .. })
}
