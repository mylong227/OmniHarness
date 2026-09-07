//! 库入口。

pub mod agent;
pub mod agents;
pub mod approval;
pub mod builtin;
pub mod context;
pub mod event;
pub mod queue;
pub mod restricted_token;
pub mod sandbox;
pub mod session;
pub mod store;
pub mod tool;

pub use agent::AgentLoop;
pub use agents::{AgentError, AgentNode, AgentRegistry};
pub use approval::{ApprovalEngine, Decision, FnGuardian, Guardian, RuleDecision};
pub use builtin::{
    EchoTool, ListDirTool, MathEvalTool, NowTool, ReadFileTool, ShellRunTool, WriteFileTool,
};
pub use context::{
    estimate_text_tokens, ContextFragment, ContextManager, Summarizer, TruncateSummarizer,
};
pub use event::{EventType, SessionEvent};
pub use queue::{EventQueue, Op, Submission, SubmissionQueue};
#[cfg(windows)]
pub use restricted_token::RestrictedProcessLauncher;
pub use restricted_token::RestrictedTokenSandbox;
pub use sandbox::{
    BwrapSandbox, DangerousCommands, PlatformSandbox, PolicySandbox, Sandbox, SandboxAction,
    SandboxDecision, SeatbeltSandbox,
};
pub use session::Session;
pub use store::{MemoryStore, RolloutStore};
pub use tool::{Tool, ToolArgs, ToolMeta, ToolResult};
