//! 审批引擎：allow / deny / ask 三态 + 工具级与命令前缀规则 + Guardian 自动审查。
//! 对齐 Codex `approvals.rs` 原语与 `exec_policy` 前缀策略；fail-closed（默认拒绝）。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 规则裁决（声明态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleDecision {
    /// 放行。
    Allow,
    /// 拒绝。
    Deny,
    /// 需人工裁决。
    Ask,
}

/// 最终裁决（含理由）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Decision {
    /// 放行。
    Allow,
    /// 拒绝（含理由）。
    Deny { reason: String },
    /// 需人工裁决（含理由）。
    Ask { reason: String },
}

impl Decision {
    /// 是否放行。
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allow)
    }
}

/// Guardian：LLM 自动审查（任意模型实现此 trait 即可接入）。
pub trait Guardian: Send + Sync {
    /// 审查一次工具调用；返回 None 表示不表态（交由规则/默认值裁决）。
    fn review(&self, name: &str, args: &serde_json::Value) -> Option<(bool, String)>;
}

/// 函数式 Guardian：注入任意审查逻辑（含调用远端模型）。
pub struct FnGuardian<F>
where
    F: Fn(&str, &serde_json::Value) -> Option<(bool, String)> + Send + Sync,
{
    inner: F,
}

impl<F> FnGuardian<F>
where
    F: Fn(&str, &serde_json::Value) -> Option<(bool, String)> + Send + Sync,
{
    /// 以闭包构造。
    pub fn new(inner: F) -> Self {
        Self { inner }
    }
}

impl<F> Guardian for FnGuardian<F>
where
    F: Fn(&str, &serde_json::Value) -> Option<(bool, String)> + Send + Sync,
{
    fn review(&self, name: &str, args: &serde_json::Value) -> Option<(bool, String)> {
        (self.inner)(name, args)
    }
}

/// 审批引擎：规则优先 → Guardian 兜底 → 默认裁决（默认 deny，fail-closed）。
pub struct ApprovalEngine {
    default: RuleDecision,
    tool_rules: HashMap<String, RuleDecision>,
    prefix_rules: Vec<(String, RuleDecision)>,
    guardian: Option<Box<dyn Guardian>>,
}

impl ApprovalEngine {
    /// fail-closed：默认拒绝一切。
    pub fn deny_all() -> Self {
        Self::new(RuleDecision::Deny)
    }

    /// 全放行（仅受信任环境）。
    pub fn allow_all() -> Self {
        Self::new(RuleDecision::Allow)
    }

    /// 以默认裁决构造（未命中规则时使用）。
    pub fn new(default: RuleDecision) -> Self {
        Self {
            default,
            tool_rules: HashMap::new(),
            prefix_rules: Vec::new(),
            guardian: None,
        }
    }

    /// 注入 Guardian 自动审查。
    pub fn with_guardian(mut self, guardian: Box<dyn Guardian>) -> Self {
        self.guardian = Some(guardian);
        self
    }

    /// 工具级规则（精确匹配工具名）。
    pub fn add_tool_rule(&mut self, name: impl Into<String>, decision: RuleDecision) {
        self.tool_rules.insert(name.into(), decision);
    }

    /// 命令前缀规则（用于 shell 类工具：按命令前缀裁决）。
    pub fn add_prefix_rule(&mut self, prefix: impl Into<String>, decision: RuleDecision) {
        self.prefix_rules.push((prefix.into(), decision));
    }

    /// 默认裁决。
    pub fn default_decision(&self) -> RuleDecision {
        self.default
    }

    /// 裁决一次工具调用：工具级 → 前缀 → Guardian → 默认。
    pub fn evaluate(&self, name: &str, args: &serde_json::Value) -> Decision {
        if let Some(decision) = self.tool_rules.get(name) {
            return rule_to_decision(*decision, "命中工具级规则");
        }
        if let Some((prefix, decision)) = self.match_prefix(args) {
            return rule_to_decision(*decision, &format!("命中命令前缀规则: {}", prefix));
        }
        if let Some(guardian) = &self.guardian {
            if let Some((approved, reason)) = guardian.review(name, args) {
                return if approved {
                    Decision::Allow
                } else {
                    Decision::Deny {
                        reason: format!("Guardian 拒绝: {}", reason),
                    }
                };
            }
        }
        rule_to_decision(self.default, "默认裁决")
    }

    /// 从参数中取命令（约定字段 `command`），匹配最长前缀。
    fn match_prefix(&self, args: &serde_json::Value) -> Option<&(String, RuleDecision)> {
        let command = args.get("command").and_then(|v| v.as_str())?;
        let trimmed = command.trim();
        self.prefix_rules
            .iter()
            .filter(|(prefix, _)| trimmed.starts_with(prefix.as_str()))
            .max_by_key(|(prefix, _)| prefix.len())
    }
}

/// 规则裁决 → 最终裁决（附理由）。
fn rule_to_decision(rule: RuleDecision, reason: &str) -> Decision {
    match rule {
        RuleDecision::Allow => Decision::Allow,
        RuleDecision::Deny => Decision::Deny {
            reason: reason.to_string(),
        },
        RuleDecision::Ask => Decision::Ask {
            reason: reason.to_string(),
        },
    }
}
