//! 上下文管理器：碎片注入 + token 估算 + 双通道压缩 + 推理摘要保留。
//! 对齐 TS 侧 `src/context/*`：TokenEstimator（中文 1 字 1 token，其余 4 字符 1 token）、
//! ContextAssembler（碎片拼装）、ContextCompactor（本地摘要 + 远端通道）。

/// 上下文碎片（Codex world_state 思路：~50 个碎片按需拼装）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFragment {
    /// 碎片键（如 `world_state`、`developer_instructions`）。
    pub key: String,
    /// 碎片内容。
    pub content: String,
}

impl ContextFragment {
    /// 便捷构造。
    pub fn new(key: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            content: content.into(),
        }
    }
}

/// 一轮对话记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRecord {
    /// 角色（user/assistant/tool）。
    pub role: String,
    /// 文本。
    pub text: String,
}

/// 摘要器：压缩时把历史折叠成摘要。双通道——远端通道（走模型）优先，本地兜底。
pub trait Summarizer: Send + Sync {
    /// 把输入文本折叠为摘要。
    fn summarize(&self, text: &str) -> String;
}

/// 本地兜底摘要器：摘要标记 + 截断（无模型时的确定性行为，便于测试）。
pub struct TruncateSummarizer {
    max_chars: usize,
}

impl TruncateSummarizer {
    /// 以最大字符数构造。
    pub fn new(max_chars: usize) -> Self {
        Self { max_chars }
    }
}

impl Default for TruncateSummarizer {
    fn default() -> Self {
        Self::new(200)
    }
}

impl Summarizer for TruncateSummarizer {
    fn summarize(&self, text: &str) -> String {
        let collapsed: String = text.split_whitespace().collect::<Vec<&str>>().join(" ");
        if collapsed.chars().count() <= self.max_chars {
            return format!("[摘要] {}", collapsed);
        }
        let head: String = collapsed.chars().take(self.max_chars).collect();
        format!("[摘要] {}…", head)
    }
}

/// 函数式摘要器：注入任意摘要实现（远端 `/responses/compact` 或本地模型）。
pub struct FnSummarizer<F>
where
    F: Fn(&str) -> String + Send + Sync,
{
    inner: F,
}

impl<F> FnSummarizer<F>
where
    F: Fn(&str) -> String + Send + Sync,
{
    /// 以闭包构造。
    pub fn new(inner: F) -> Self {
        Self { inner }
    }
}

impl<F> Summarizer for FnSummarizer<F>
where
    F: Fn(&str) -> String + Send + Sync,
{
    fn summarize(&self, text: &str) -> String {
        (self.inner)(text)
    }
}

/// 上下文管理器：模型所见 = 碎片 + 保留历史 + 压缩摘要 + 推理摘要。
pub struct ContextManager {
    fragments: Vec<ContextFragment>,
    turns: Vec<TurnRecord>,
    reasoning: Vec<String>,
    summary: Option<String>,
    budget: usize,
    keep_recent: usize,
    summarizer: Box<dyn Summarizer>,
}

impl ContextManager {
    /// 以 token 预算构造（默认用本地兜底摘要器）。
    pub fn new(budget: usize) -> Self {
        Self {
            fragments: Vec::new(),
            turns: Vec::new(),
            reasoning: Vec::new(),
            summary: None,
            budget,
            keep_recent: 4,
            summarizer: Box::new(TruncateSummarizer::default()),
        }
    }

    /// 注入自定义摘要器（远端压缩通道）。
    pub fn with_summarizer(mut self, summarizer: Box<dyn Summarizer>) -> Self {
        self.summarizer = summarizer;
        self
    }

    /// 设置压缩时保留的最近轮数。
    pub fn with_keep_recent(mut self, keep_recent: usize) -> Self {
        self.keep_recent = keep_recent;
        self
    }

    /// 注入上下文碎片（键相同时覆盖，保证碎片幂等）。
    pub fn add_fragment(&mut self, key: impl Into<String>, content: impl Into<String>) {
        let key = key.into();
        let content = content.into();
        match self.fragments.iter_mut().find(|f| f.key == key) {
            Some(existing) => existing.content = content,
            None => self.fragments.push(ContextFragment::new(key, content)),
        }
    }

    /// 追加一轮对话。
    pub fn push_turn(&mut self, role: impl Into<String>, text: impl Into<String>) {
        self.turns.push(TurnRecord {
            role: role.into(),
            text: text.into(),
        });
    }

    /// 追加推理摘要（压缩不被丢弃，对齐 Codex ReasoningSummary）。
    pub fn push_reasoning(&mut self, text: impl Into<String>) {
        self.reasoning.push(text.into());
    }

    /// 推理摘要只读视图。
    pub fn reasoning_summaries(&self) -> &[String] {
        &self.reasoning
    }

    /// 已记录轮次只读视图。
    pub fn turns(&self) -> &[TurnRecord] {
        &self.turns
    }

    /// 当前压缩摘要。
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }

    /// 估算当前上下文 token 数。
    pub fn estimate_tokens(&self) -> usize {
        let fragments: usize = self
            .fragments
            .iter()
            .map(|f| estimate_text_tokens(&f.content))
            .sum();
        let turns: usize = self
            .turns
            .iter()
            .map(|t| estimate_text_tokens(&t.text) + 4)
            .sum();
        let reasoning: usize = self.reasoning.iter().map(|r| estimate_text_tokens(r)).sum();
        let summary = self
            .summary
            .as_deref()
            .map(estimate_text_tokens)
            .unwrap_or(0);
        fragments + turns + reasoning + summary
    }

    /// 是否超出预算需要压缩。
    pub fn needs_compaction(&self) -> bool {
        self.estimate_tokens() > self.budget
    }

    /// 执行压缩：折叠较早历史为摘要，保留最近 `keep_recent` 轮；推理摘要不清空。
    /// 返回压缩前后 token 数。
    pub fn compact(&mut self) -> (usize, usize) {
        let before = self.estimate_tokens();
        if self.turns.len() <= self.keep_recent {
            return (before, before);
        }
        let split_at = self.turns.len() - self.keep_recent;
        let older: Vec<TurnRecord> = self.turns.drain(..split_at).collect();
        let merged = self.merge_for_summary(&older);
        self.summary = Some(self.summarizer.summarize(&merged));
        (before, self.estimate_tokens())
    }

    /// 拼装模型可见上下文：碎片 → 摘要 → 推理摘要 → 最近历史。
    pub fn render(&self) -> String {
        let mut out = String::new();
        for fragment in &self.fragments {
            out.push_str(&format!("[{}]\n{}\n\n", fragment.key, fragment.content));
        }
        if let Some(summary) = &self.summary {
            out.push_str(&format!("[历史摘要]\n{}\n\n", summary));
        }
        if !self.reasoning.is_empty() {
            out.push_str("[推理摘要]\n");
            for item in &self.reasoning {
                out.push_str(&format!("- {}\n", item));
            }
            out.push('\n');
        }
        for turn in &self.turns {
            out.push_str(&format!("{}: {}\n", turn.role, turn.text));
        }
        out
    }

    /// 把待折叠历史拼成摘要输入。
    fn merge_for_summary(&self, older: &[TurnRecord]) -> String {
        let mut merged = String::new();
        for turn in older {
            merged.push_str(&format!("{}: {}\n", turn.role, turn.text));
        }
        if let Some(previous) = &self.summary {
            merged.push_str(&format!("前序摘要: {}\n", previous));
        }
        merged
    }
}

/// 估算单段文本 token 数：中日韩 1 字 1 token，其余 4 字符 1 token（对齐 TS TokenEstimator）。
pub fn estimate_text_tokens(text: &str) -> usize {
    let cjk = text.chars().filter(|c| is_cjk(*c)).count();
    let other = text.chars().count() - cjk;
    cjk + other.div_ceil(4)
}

/// 是否中日韩统一表意文字/假名/韩文音节。
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4e00}'..='\u{9fff}'
        | '\u{3040}'..='\u{30ff}'
        | '\u{ac00}'..='\u{d7af}'
    )
}
