//! SQ/EQ 双队列：Submission（入站）与 Op（出站），对齐 Codex Session 状态机。

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

/// 入站提交：用户/模型/控制面推给内核的指令。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Submission {
    /// 用户输入（开启一回合）。
    UserInput { text: String },
    /// 模型发言。
    AssistantMessage { text: String },
    /// 模型推理（保留为 ReasoningSummary）。
    Reasoning { text: String },
    /// 请求执行工具。
    ToolCall {
        call_id: String,
        name: String,
        args: serde_json::Value,
    },
    /// 人工裁决回复（配合 ask 态审批）。
    ApprovalReply { call_id: String, approved: bool },
    /// 立即压缩上下文。
    Compact,
    /// 中断当前回合。
    Interrupt,
    /// 关闭会话。
    Shutdown,
}

/// 出站操作：内核对外通告（供 CLI/TS/wasm 消费）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Op {
    /// 回合开始。
    TurnStarted,
    /// 模型发言。
    AssistantMessage { text: String },
    /// 推理摘要（压缩后仍保留）。
    Reasoning { text: String },
    /// 工具调用（已进入执行链）。
    ToolCall {
        call_id: String,
        name: String,
        args: serde_json::Value,
    },
    /// 工具结果。
    ToolResult {
        call_id: String,
        ok: bool,
        output: String,
    },
    /// 需人工裁决（ask 态）。
    ApprovalRequired {
        call_id: String,
        name: String,
        reason: String,
    },
    /// 上下文压缩完成（before/after token 数）。
    Compacted {
        before_tokens: usize,
        after_tokens: usize,
    },
    /// 错误通告（门禁拒绝等，fail-closed）。
    Error { message: String },
    /// 回合结束。
    TurnCompleted,
    /// 会话关闭。
    Shutdown,
}

impl Op {
    /// 序列化为 JSON 字符串（CLI / wasm 输出用）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// 序列化为 JSON 值（便于嵌入复合响应）。
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

/// 入站队列（SQ）。
#[derive(Debug, Default)]
pub struct SubmissionQueue {
    items: VecDeque<Submission>,
}

impl SubmissionQueue {
    /// 空队列。
    pub fn new() -> Self {
        Self {
            items: VecDeque::new(),
        }
    }

    /// 入队一条提交。
    pub fn push(&mut self, submission: Submission) {
        self.items.push_back(submission);
    }

    /// 出队一条提交。
    pub fn pop(&mut self) -> Option<Submission> {
        self.items.pop_front()
    }

    /// 队列长度。
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// 清空队列（Interrupt 语义）。
    pub fn clear(&mut self) {
        self.items.clear();
    }
}

/// 出站队列（EQ）。
#[derive(Debug, Default)]
pub struct EventQueue {
    items: VecDeque<Op>,
}

impl EventQueue {
    /// 空队列。
    pub fn new() -> Self {
        Self {
            items: VecDeque::new(),
        }
    }

    /// 入队一条操作。
    pub fn push(&mut self, op: Op) {
        self.items.push_back(op);
    }

    /// 出队一条操作。
    pub fn pop(&mut self) -> Option<Op> {
        self.items.pop_front()
    }

    /// 队列长度。
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// 一次性取出全部操作（顺序保持）。
    pub fn drain_all(&mut self) -> Vec<Op> {
        self.items.drain(..).collect()
    }
}
