//! AgentLoop 单元测试。

use omni_core::agent::AgentLoop;
use omni_core::event::EventType;
use omni_core::tool::{Tool, ToolArgs, ToolResult};

/// 测试工具：返回固定字符串。
struct StaticTool;

impl Tool for StaticTool {
    fn name(&self) -> &str {
        "static_tool"
    }

    fn call(&self, _args: ToolArgs) -> ToolResult {
        ToolResult::ok("fixed-output")
    }
}

/// 测试工具：按参数返回。
struct RepeatTool;

impl Tool for RepeatTool {
    fn name(&self) -> &str {
        "repeat"
    }

    fn call(&self, args: ToolArgs) -> ToolResult {
        match args.get("times").and_then(serde_json::Value::as_u64) {
            Some(n) => ToolResult::ok(format!("x{}", n)),
            None => ToolResult::err("缺少 times"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_tool_runs_and_emits_call_result() {
        let mut loop_ = AgentLoop::new();
        loop_.register(Box::new(StaticTool));
        let (call, result) = loop_.run_tool("s1", "c1", "static_tool", serde_json::json!({}));
        assert_eq!(call.r#type, EventType::ToolCall);
        assert_eq!(result.r#type, EventType::ToolResult);
        assert_eq!(result.payload["ok"], true);
        assert_eq!(result.payload["output"], "fixed-output");
    }

    #[test]
    fn unknown_tool_fails_closed_without_panic() {
        let loop_ = AgentLoop::new();
        let (_, result) = loop_.run_tool("s1", "c1", "nope", serde_json::json!({}));
        assert_eq!(result.payload["ok"], false);
        assert_eq!(result.payload["output"], "工具不存在: nope");
    }

    #[test]
    fn tool_receives_args() {
        let mut loop_ = AgentLoop::new();
        loop_.register(Box::new(RepeatTool));
        let (_, result) = loop_.run_tool("s1", "c2", "repeat", serde_json::json!({ "times": 3 }));
        assert_eq!(result.payload["output"], "x3");
    }

    #[test]
    fn tool_missing_arg_returns_error_result() {
        let mut loop_ = AgentLoop::new();
        loop_.register(Box::new(RepeatTool));
        let (_, result) = loop_.run_tool("s1", "c3", "repeat", serde_json::json!({}));
        assert_eq!(result.payload["ok"], false);
        assert_eq!(result.payload["output"], "缺少 times");
    }

    #[test]
    fn session_event_serializes_to_json() {
        let e = omni_core::event::SessionEvent::tool_call(
            "s1",
            "c9",
            "echo",
            serde_json::json!({ "text": "hi" }),
        );
        let json = e.to_json();
        assert!(json.contains("\"type\":\"tool_call\""));
        assert!(json.contains("\"session_id\":\"s1\""));
    }

    #[test]
    fn register_builtins_exposes_metadata_and_routes() {
        let mut loop_ = AgentLoop::new();
        loop_.register_builtins(std::env::temp_dir());
        // 元数据自省：7 个内置工具（native 含 shell.run），按名排序。
        let metas = loop_.list_tools();
        let names: Vec<&str> = metas.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "echo",
                "fs.list_dir",
                "fs.read_file",
                "fs.write_file",
                "math.eval",
                "now",
                "shell.run"
            ]
        );
        // 元数据含参数 schema。
        let math = metas.iter().find(|m| m.name == "math.eval").unwrap();
        assert!(math.param_schema.get("expression").is_some());
        let list_dir = metas.iter().find(|m| m.name == "fs.list_dir").unwrap();
        assert!(!list_dir.description.is_empty());
    }

    #[test]
    fn builtin_list_dir_runs_through_kernel() {
        // 建一个临时目录 + 文件，用 fs.list_dir 通过内核列举。
        let tmp = std::env::temp_dir().join(format!("omni_agent_listdir_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let _ = std::fs::write(tmp.join("k.txt"), "k");
        let mut loop_ = AgentLoop::new();
        loop_.register_builtins(tmp.clone());
        let (_, result) = loop_.run_tool("s1", "c23", "fs.list_dir", serde_json::json!({}));
        assert_eq!(result.payload["ok"], true);
        let items: Vec<serde_json::Value> =
            serde_json::from_str(result.payload["output"].as_str().unwrap_or(""))
                .unwrap_or_default();
        let names: Vec<&str> = items.iter().filter_map(|i| i["name"].as_str()).collect();
        assert!(names.contains(&"k.txt"), "应列出内核根下文件");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn builtin_math_runs_through_kernel() {
        let mut loop_ = AgentLoop::new();
        loop_.register_builtins(std::env::temp_dir());
        let (_, result) = loop_.run_tool(
            "s1",
            "c20",
            "math.eval",
            serde_json::json!({ "expression": "1+2*3" }),
        );
        assert_eq!(result.payload["ok"], true);
        assert_eq!(result.payload["output"], "7");
    }

    #[test]
    fn builtin_now_and_echo_run() {
        let mut loop_ = AgentLoop::new();
        loop_.register_builtins(std::env::temp_dir());
        let (_, now) = loop_.run_tool("s1", "c21", "now", serde_json::json!({}));
        assert_eq!(now.payload["ok"], true);
        assert!(!now.payload["output"].as_str().unwrap_or("").is_empty());
        let (_, echo) = loop_.run_tool("s1", "c22", "echo", serde_json::json!({ "text": "hi" }));
        assert_eq!(echo.payload["output"], "echo: hi");
    }
}
