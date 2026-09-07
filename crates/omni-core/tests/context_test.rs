//! ContextManager 单元测试。

use omni_core::context::{
    estimate_text_tokens, ContextManager, FnSummarizer, Summarizer, TruncateSummarizer,
};

#[test]
fn cjk_counts_one_token_per_char() {
    assert_eq!(estimate_text_tokens("你好"), 2);
    assert_eq!(estimate_text_tokens("abcd"), 1);
    assert_eq!(estimate_text_tokens("你好ab"), 3);
}

#[test]
fn fragment_injection_is_idempotent_by_key() {
    let mut ctx = ContextManager::new(1000);
    ctx.add_fragment("world_state", "第一版");
    ctx.add_fragment("world_state", "第二版");
    let rendered = ctx.render();
    assert!(rendered.contains("第二版"));
    assert!(!rendered.contains("第一版"));
}

#[test]
fn compaction_keeps_recent_turns_and_produces_summary() {
    let mut ctx = ContextManager::new(1000).with_keep_recent(2);
    for i in 0..6 {
        ctx.push_turn("user", format!("第{}轮", i));
    }
    let (before, after) = ctx.compact();
    assert!(after < before);
    assert_eq!(ctx.turns().len(), 2);
    assert!(ctx.summary().is_some());
    assert!(ctx.summary().unwrap().contains("[摘要]"));
}

#[test]
fn compaction_preserves_reasoning_summaries() {
    let mut ctx = ContextManager::new(1000).with_keep_recent(1);
    ctx.push_reasoning("推理一");
    ctx.push_reasoning("推理二");
    for i in 0..5 {
        ctx.push_turn("user", format!("内容{}", i));
    }
    ctx.compact();
    assert_eq!(ctx.reasoning_summaries().len(), 2);
    assert!(ctx.render().contains("推理一"));
}

#[test]
fn needs_compaction_follows_budget() {
    let mut ctx = ContextManager::new(10);
    assert!(!ctx.needs_compaction());
    ctx.push_turn("user", "这是一段很长的中文内容，用来超过预算".to_string());
    assert!(ctx.needs_compaction());
}

#[test]
fn custom_summarizer_is_used() {
    let summarizer = Box::new(FnSummarizer::new(|_| "自定义摘要".to_string()));
    let mut ctx = ContextManager::new(1000)
        .with_summarizer(summarizer)
        .with_keep_recent(1);
    ctx.push_turn("user", "一");
    ctx.push_turn("user", "二");
    ctx.compact();
    assert_eq!(ctx.summary(), Some("自定义摘要"));
}

#[test]
fn truncate_summarizer_collapses_whitespace() {
    let summarizer = TruncateSummarizer::new(50);
    let out: String = Summarizer::summarize(&summarizer, "a   b\n c");
    assert_eq!(out, "[摘要] a b c");
}
