//! 审批引擎单元测试。

use omni_core::approval::{ApprovalEngine, Decision, FnGuardian, RuleDecision};

#[test]
fn default_is_fail_closed() {
    let engine = ApprovalEngine::deny_all();
    let decision = engine.evaluate("shell", &serde_json::json!({ "command": "echo hi" }));
    assert!(!decision.is_allowed());
    assert!(matches!(decision, Decision::Deny { .. }));
}

#[test]
fn tool_rule_overrides_default() {
    let mut engine = ApprovalEngine::deny_all();
    engine.add_tool_rule("echo", RuleDecision::Allow);
    assert!(engine.evaluate("echo", &serde_json::json!({})).is_allowed());
    assert!(!engine
        .evaluate("shell", &serde_json::json!({}))
        .is_allowed());
}

#[test]
fn prefix_rule_matches_longest_prefix() {
    let mut engine = ApprovalEngine::deny_all();
    engine.add_prefix_rule("git", RuleDecision::Allow);
    engine.add_prefix_rule("git push", RuleDecision::Ask);
    let allow = engine.evaluate("shell", &serde_json::json!({ "command": "git status" }));
    assert!(allow.is_allowed());
    let ask = engine.evaluate(
        "shell",
        &serde_json::json!({ "command": "git push origin main" }),
    );
    assert!(matches!(ask, Decision::Ask { .. }));
}

#[test]
fn ask_rule_reports_reason() {
    let mut engine = ApprovalEngine::deny_all();
    engine.add_prefix_rule("npm", RuleDecision::Ask);
    match engine.evaluate("shell", &serde_json::json!({ "command": "npm publish" })) {
        Decision::Ask { reason } => assert!(reason.contains("npm")),
        other => panic!("应为 Ask，实际 {:?}", other),
    }
}

#[test]
fn guardian_decides_when_rules_silent() {
    let guardian = Box::new(FnGuardian::new(|name, _args| match name {
        "danger" => Some((false, "高危操作".to_string())),
        "safe" => Some((true, "无风险".to_string())),
        _ => None,
    }));
    let engine = ApprovalEngine::deny_all().with_guardian(guardian);
    assert!(engine.evaluate("safe", &serde_json::json!({})).is_allowed());
    match engine.evaluate("danger", &serde_json::json!({})) {
        Decision::Deny { reason } => assert!(reason.contains("Guardian")),
        other => panic!("应为 Deny，实际 {:?}", other),
    }
    // Guardian 不表态 → 回落默认裁决。
    assert!(!engine
        .evaluate("other", &serde_json::json!({}))
        .is_allowed());
}

#[test]
fn tool_rule_takes_priority_over_guardian() {
    let guardian = Box::new(FnGuardian::new(|_, _| {
        Some((false, " Guardian 一律拒绝".to_string()))
    }));
    let mut engine = ApprovalEngine::new(RuleDecision::Allow).with_guardian(guardian);
    engine.add_tool_rule("trusted", RuleDecision::Allow);
    assert!(engine
        .evaluate("trusted", &serde_json::json!({}))
        .is_allowed());
}

#[test]
fn allow_all_engine_permits_unknown_tools() {
    let engine = ApprovalEngine::allow_all();
    assert_eq!(engine.default_decision(), RuleDecision::Allow);
    assert!(engine
        .evaluate("anything", &serde_json::json!({}))
        .is_allowed());
}
