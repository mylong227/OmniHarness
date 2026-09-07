//! Agent 循环：核心工具执行链 —— 路由 → 执行 → 记录（fail-closed）。

use std::collections::HashMap;
use std::path::PathBuf;

use crate::builtin::{
    EchoTool, ListDirTool, MathEvalTool, NowTool, ReadFileTool, ShellRunTool, WriteFileTool,
};
use crate::event::SessionEvent;
use crate::tool::{Tool, ToolArgs, ToolMeta, ToolResult};

/// Agent 循环：持有工具表，执行工具调用并产出事件流。
pub struct AgentLoop {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl AgentLoop {
    /// 创建空的 agent 循环（fail-closed：无工具时任何调用都拒绝）。
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// 注册工具。
    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// 注册标准内置工具集。文件类工具以 `root` 为沙箱白名单根目录。
    pub fn register_builtins(&mut self, root: impl Into<PathBuf>) {
        let root = root.into();
        self.register(Box::new(EchoTool));
        self.register(Box::new(NowTool));
        self.register(Box::new(MathEvalTool));
        self.register(Box::new(ReadFileTool::new(root.clone())));
        self.register(Box::new(WriteFileTool::new(root.clone())));
        self.register(Box::new(ListDirTool::new(root)));
        #[cfg(not(target_arch = "wasm32"))]
        self.register(Box::new(ShellRunTool));
    }

    /// 列出全部已注册工具元数据（供自省 / TS 生成 ToolSpec / 权限判定）。
    pub fn list_tools(&self) -> Vec<ToolMeta> {
        let mut metas: Vec<ToolMeta> = self.tools.values().map(|t| t.meta()).collect();
        metas.sort_by(|a, b| a.name.cmp(&b.name));
        metas
    }

    /// 执行一次工具调用，产出 工具调用 + 工具结果 两条事件。
    /// 未知工具名 → 返回错误结果（fail-closed），不 panic。
    pub fn run_tool(
        &self,
        session_id: &str,
        call_id: &str,
        name: &str,
        args: ToolArgs,
    ) -> (SessionEvent, SessionEvent) {
        let call_event = SessionEvent::tool_call(session_id, call_id, name, args.clone());
        let result = match self.tools.get(name) {
            Some(tool) => tool.call(args),
            None => ToolResult::err(format!("工具不存在: {}", name)),
        };
        let result_event = match &result.error {
            Some(e) => SessionEvent::tool_result(session_id, call_id, false, e),
            None => SessionEvent::tool_result(session_id, call_id, true, &result.output),
        };
        (call_event, result_event)
    }
}

impl Default for AgentLoop {
    fn default() -> Self {
        Self::new()
    }
}
