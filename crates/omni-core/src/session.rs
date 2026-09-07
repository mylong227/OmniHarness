//! 会话状态机：SQ/EQ 驱动，串起 审批 → 沙箱 → 执行 → 记录 → 压缩 的完整执行链。

use std::path::PathBuf;

use crate::agent::AgentLoop;
use crate::approval::{ApprovalEngine, Decision, RuleDecision};
use crate::context::ContextManager;
use crate::event::SessionEvent;
use crate::queue::{EventQueue, Op, Submission, SubmissionQueue};
use crate::restricted_token::RestrictedTokenSandbox;
use crate::sandbox::{PlatformSandbox, PolicySandbox, Sandbox, SandboxAction};
use crate::store::MemoryStore;

/// 默认上下文 token 预算。
pub const DEFAULT_TOKEN_BUDGET: usize = 4096;

/// 等待人工裁决的挂起调用。
#[derive(Debug, Clone)]
struct PendingCall {
    call_id: String,
    name: String,
    args: serde_json::Value,
}

/// 会话：一个会话一个状态机，入站走 SQ、出站走 EQ。
pub struct Session {
    id: String,
    agent: AgentLoop,
    context: ContextManager,
    approval: ApprovalEngine,
    sandbox: Option<Box<dyn Sandbox>>,
    os_sandbox: Option<Box<dyn PlatformSandbox>>,
    sq: SubmissionQueue,
    eq: EventQueue,
    log: MemoryStore,
    pending: Option<PendingCall>,
    turn_open: bool,
    alive: bool,
}

impl Session {
    /// 以最小配置构造（fail-closed：无工具、默认拒绝、无沙箱）。
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            agent: AgentLoop::new(),
            context: ContextManager::new(DEFAULT_TOKEN_BUDGET),
            approval: ApprovalEngine::deny_all(),
            sandbox: None,
            os_sandbox: None,
            sq: SubmissionQueue::new(),
            eq: EventQueue::new(),
            log: MemoryStore::new(),
            pending: None,
            turn_open: false,
            alive: true,
        }
    }

    /// 标准配置：内置工具集 + 工作区策略沙箱 + OS 级沙箱（可用时自动启用）+ 默认放行审批。
    /// 执行链：审批 → 策略沙箱 → OS 沙箱 → 执行 → 记录 → 压缩。
    pub fn standard(id: impl Into<String>, workspace_root: impl Into<PathBuf>) -> Self {
        let root = workspace_root.into();
        let mut session = Self::new(id);
        session.agent_mut().register_builtins(root.clone());
        session.approval = ApprovalEngine::new(RuleDecision::Allow);
        session.sandbox = Some(Box::new(PolicySandbox::new(root)));
        session.os_sandbox = Some(Box::new(RestrictedTokenSandbox));
        session
    }

    /// 会话 ID。
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 是否存活（收到 Shutdown 后为 false）。
    pub fn is_alive(&self) -> bool {
        self.alive
    }

    /// 上下文只读访问。
    pub fn context(&self) -> &ContextManager {
        &self.context
    }

    /// 上下文可变访问（注入碎片、调整预算）。
    pub fn context_mut(&mut self) -> &mut ContextManager {
        &mut self.context
    }

    /// 工具注册表可变访问。
    pub fn agent_mut(&mut self) -> &mut AgentLoop {
        &mut self.agent
    }

    /// 审批引擎可变访问。
    pub fn approval_mut(&mut self) -> &mut ApprovalEngine {
        &mut self.approval
    }

    /// 设置沙箱后端。
    pub fn set_sandbox(&mut self, sandbox: Box<dyn Sandbox>) {
        self.sandbox = Some(sandbox);
    }

    /// 设置 OS 级沙箱后端（RestrictedToken/bwrap/seatbelt）。
    pub fn set_os_sandbox(&mut self, sandbox: Box<dyn PlatformSandbox>) {
        self.os_sandbox = Some(sandbox);
    }

    /// 事件日志（append-only 事实源）。
    pub fn events(&self) -> &[SessionEvent] {
        self.log.all()
    }

    /// 提交一条入站指令。
    pub fn submit(&mut self, submission: Submission) {
        self.sq.push(submission);
    }

    /// 处理一条入站指令；返回是否处理了指令。
    pub fn run_once(&mut self) -> bool {
        let Some(submission) = self.sq.pop() else {
            return false;
        };
        match submission {
            Submission::UserInput { text } => self.handle_user_input(text),
            Submission::AssistantMessage { text } => self.handle_assistant_message(text),
            Submission::Reasoning { text } => self.handle_reasoning(text),
            Submission::ToolCall {
                call_id,
                name,
                args,
            } => self.handle_tool_call(call_id, name, args),
            Submission::ApprovalReply { call_id, approved } => {
                self.handle_approval_reply(call_id, approved)
            }
            Submission::Compact => self.run_compaction(),
            Submission::Interrupt => self.handle_interrupt(),
            Submission::Shutdown => self.handle_shutdown(),
        }
        true
    }

    /// 处理到入站队列清空为止；无挂起裁决时闭合回合。
    pub fn run_until_idle(&mut self) {
        while self.run_once() {}
        self.close_open_turn();
    }

    /// 闭合未结束的回合（挂起裁决时保持开启，等待裁决回复）。
    fn close_open_turn(&mut self) {
        if self.turn_open && self.pending.is_none() {
            self.turn_open = false;
            self.eq.push(Op::TurnCompleted);
        }
    }

    /// 取出一条出站操作。
    pub fn next_op(&mut self) -> Option<Op> {
        self.eq.pop()
    }

    /// 取出全部出站操作。
    pub fn drain_ops(&mut self) -> Vec<Op> {
        self.eq.drain_all()
    }

    /// 渲染模型可见上下文。
    pub fn render_context(&self) -> String {
        self.context.render()
    }

    /// 用户输入：开新回合 → 记日志 → 入上下文。
    fn handle_user_input(&mut self, text: String) {
        self.turn_open = true;
        self.eq.push(Op::TurnStarted);
        self.record_and_track("user", &text);
        self.run_compaction_if_needed();
    }

    /// 模型发言：记日志 → 入上下文。
    fn handle_assistant_message(&mut self, text: String) {
        self.eq.push(Op::AssistantMessage { text: text.clone() });
        self.record_and_track("assistant", &text);
        self.run_compaction_if_needed();
    }

    /// 推理：记日志并保留为 ReasoningSummary（压缩不清空）。
    fn handle_reasoning(&mut self, text: String) {
        self.eq.push(Op::Reasoning { text: text.clone() });
        self.context.push_reasoning(text.clone());
        self.log.append(&SessionEvent {
            id: format!("evt_reasoning_{}", self.log.len()),
            r#type: crate::event::EventType::Reasoning,
            session_id: self.id.clone(),
            timestamp: crate::event::now_iso(),
            payload: serde_json::json!({ "text": text }),
        });
    }

    /// 工具调用：审批 → 沙箱 → 执行 → 记录 → 压缩。
    fn handle_tool_call(&mut self, call_id: String, name: String, args: serde_json::Value) {
        match self.approval.evaluate(&name, &args) {
            Decision::Deny { reason } => self.reject_call(&call_id, &name, reason),
            Decision::Ask { reason } => self.ask_call(call_id, name, args, reason),
            Decision::Allow => {
                if let Some(reason) = self.sandbox_reason(&name, &args) {
                    self.reject_call(&call_id, &name, reason);
                    return;
                }
                self.execute_call(call_id, name, args);
            }
        }
    }

    /// 人工裁决回复：放行则执行，否则拒绝。
    fn handle_approval_reply(&mut self, call_id: String, approved: bool) {
        let Some(pending) = self.pending.take() else {
            self.eq.push(Op::Error {
                message: format!("无待裁决调用: {}", call_id),
            });
            return;
        };
        if pending.call_id != call_id {
            self.pending = Some(pending);
            self.eq.push(Op::Error {
                message: format!("裁决 ID 不匹配: {}", call_id),
            });
            return;
        }
        if approved {
            self.execute_call(pending.call_id, pending.name, pending.args);
        } else {
            self.reject_call(&pending.call_id, &pending.name, "人工裁决拒绝".to_string());
        }
    }

    /// 中断：清空入站队列，结束回合。
    fn handle_interrupt(&mut self) {
        self.sq.clear();
        self.pending = None;
        self.turn_open = false;
        self.eq.push(Op::TurnCompleted);
    }

    /// 关闭会话。
    fn handle_shutdown(&mut self) {
        self.alive = false;
        self.eq.push(Op::Shutdown);
    }

    /// 执行工具并产出 工具调用 / 工具结果 两条操作。
    fn execute_call(&mut self, call_id: String, name: String, mut args: serde_json::Value) {
        // OS 级沙箱：命令类工具且后端可用时，把命令替换为包装后的命令行（如受限进程包装）。
        match self.os_wrap_command(&name, &args) {
            Err(reason) => {
                self.reject_call(&call_id, &name, reason);
                return;
            }
            Ok(Some(wrapped)) => {
                args["command"] = serde_json::json!(wrapped);
            }
            Ok(None) => {}
        }
        let (call_event, result_event) =
            self.agent.run_tool(&self.id, &call_id, &name, args.clone());
        self.eq.push(Op::ToolCall {
            call_id: call_id.clone(),
            name: name.clone(),
            args,
        });
        let ok = result_event.payload["ok"] == true;
        let output = result_event.payload["output"]
            .as_str()
            .unwrap_or("")
            .to_string();
        self.eq.push(Op::ToolResult {
            call_id: call_id.clone(),
            ok,
            output: output.clone(),
        });
        self.log.append(&call_event);
        self.log.append(&result_event);
        self.context
            .push_turn("tool", format!("{}: {}", name, output));
        self.run_compaction_if_needed();
    }

    /// 拒绝工具调用（fail-closed 落日志 + 错误通告）。
    fn reject_call(&mut self, call_id: &str, name: &str, reason: String) {
        self.eq.push(Op::ToolResult {
            call_id: call_id.to_string(),
            ok: false,
            output: reason.clone(),
        });
        self.eq.push(Op::Error {
            message: format!("{} 被拒绝: {}", name, reason),
        });
        self.context
            .push_turn("tool", format!("{}: 拒绝 {}", name, reason));
    }

    /// 挂起等待人工裁决。
    fn ask_call(&mut self, call_id: String, name: String, args: serde_json::Value, reason: String) {
        self.pending = Some(PendingCall {
            call_id: call_id.clone(),
            name: name.clone(),
            args,
        });
        self.eq.push(Op::ApprovalRequired {
            call_id,
            name,
            reason,
        });
    }

    /// OS 级沙箱包装：命令类动作且后端可用时返回包装后的命令行；
    /// 不适用或后端不可用返回 None；后端可用但包装失败返回 Err（fail-closed 拒绝执行）。
    fn os_wrap_command(
        &self,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<Option<String>, String> {
        let Some(action) = sandbox_action_for(name, args) else {
            return Ok(None);
        };
        let SandboxAction::Command { command } = action else {
            return Ok(None);
        };
        let Some(os) = self.os_sandbox.as_ref() else {
            // 未配置 OS 级沙箱：用户未请求 OS 隔离，按策略沙箱路径执行（非 fail-open）。
            return Ok(None);
        };
        if !os.available() {
            // 已配置 OS 级沙箱但本平台不支持：fail-closed 拒绝执行，
            // 绝不静默退化为无隔离裸跑（与 JS 层 UnsupportedSandbox 行为一致）。
            return Err(format!(
                "OS 沙箱 {} 本平台不可用，拒绝执行以防止无隔离运行",
                os.name()
            ));
        }
        os.wrap(&command)
            .map(Some)
            .ok_or_else(|| format!("OS 沙箱 {} 可用但包装失败", os.name()))
    }

    /// 沙箱裁决：无沙箱视为放行；返回 Some(reason) 表示拒绝。
    fn sandbox_reason(&self, name: &str, args: &serde_json::Value) -> Option<String> {
        let sandbox = self.sandbox.as_ref()?;
        let action = sandbox_action_for(name, args)?;
        match sandbox.check(&action) {
            crate::sandbox::SandboxDecision { allowed: true, .. } => None,
            crate::sandbox::SandboxDecision {
                allowed: false,
                reason,
            } => Some(reason.unwrap_or_else(|| "沙箱拒绝".to_string())),
        }
    }

    /// 记录一轮文本：入事件日志 + 入上下文。
    fn record_and_track(&mut self, role: &str, text: &str) {
        self.log.append(&SessionEvent {
            id: format!("evt_{}_{}", role, self.log.len()),
            r#type: match role {
                "user" => crate::event::EventType::User,
                _ => crate::event::EventType::Assistant,
            },
            session_id: self.id.clone(),
            timestamp: crate::event::now_iso(),
            payload: serde_json::json!({ "role": role, "text": text }),
        });
        self.context.push_turn(role, text);
    }

    /// 超预算时压缩，并通告压缩点。
    fn run_compaction_if_needed(&mut self) {
        if self.context.needs_compaction() {
            self.run_compaction();
        }
    }

    /// 立即压缩。
    fn run_compaction(&mut self) {
        let (before, after) = self.context.compact();
        self.eq.push(Op::Compacted {
            before_tokens: before,
            after_tokens: after,
        });
    }
}

/// 由工具名与参数推导沙箱动作：命令类走命令门禁，路径类走路径门禁。
fn sandbox_action_for(name: &str, args: &serde_json::Value) -> Option<SandboxAction> {
    if let Some(command) = args.get("command").and_then(|v| v.as_str()) {
        return Some(SandboxAction::Command {
            command: command.to_string(),
        });
    }
    if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
        return Some(SandboxAction::Path {
            path: path.to_string(),
        });
    }
    // 文件类工具：无显式 path 时以工作区根为默认作用域，交由工具自带白名单兜底。
    if name.starts_with("fs.") {
        return Some(SandboxAction::Path {
            path: ".".to_string(),
        });
    }
    None
}
