//! 由 OmniHarness 单源 protocol schema 自动生成（勿手改）。
//! jsonrpc: 2.0，共 6 个方法。

/// 创建线程并执行任务。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsCreateParams {
    /// 任务提示词。
    pub prompt: String,

}
/// 创建线程并执行任务 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsCreateResult {
    /// 最终文本。
    pub final_text: Option<String>,
    /// 回合步数。
    pub steps: Option<f64>,
    /// 线程 ID。
    pub thread_id: Option<String>,

}

/// 续跑线程。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsContinueParams {
    /// 新提示词。
    pub prompt: String,
    /// 线程 ID。
    pub thread_id: String,

}
/// 续跑线程 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsContinueResult {
    pub final_text: Option<String>,
    pub steps: Option<f64>,
    pub thread_id: Option<String>,

}

/// 分叉线程。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsForkParams {
    /// 新提示词。
    pub prompt: String,
    /// 源线程 ID。
    pub thread_id: String,

}
/// 分叉线程 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsForkResult {
    pub final_text: Option<String>,
    pub steps: Option<f64>,
    pub thread_id: Option<String>,

}

/// 获取线程事件。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsGetParams {
    /// 线程 ID。
    pub thread_id: String,

}
/// 获取线程事件 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadsGetResult {
    /// 事件列表。
    pub items: Option<Vec<serde_json::Value>>,
    pub thread_id: Option<String>,

}

/// 运行回合（线程已存在则续跑）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnsRunParams {
    /// 提示词。
    pub prompt: String,
    /// 线程 ID（可选）。
    pub thread_id: Option<String>,

}
/// 运行回合（线程已存在则续跑） 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnsRunResult {
    pub final_text: Option<String>,
    pub steps: Option<f64>,
    pub thread_id: Option<String>,

}

/// 响应审批上行。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovalRespondParams {
    /// allow 或 deny。
    pub decision: String,
    /// 审批请求 ID。
    pub request_id: String,

}
/// 响应审批上行 的响应。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovalRespondResult {
    /// 是否成功。
    pub ok: Option<bool>,

}

/// 按方法名派发到对应类型；处理器需各自实现。
pub fn dispatch(method: &str, raw: &str) -> Result<String, String> {
    match method {
        "threads.create" => { let params: ThreadsCreateParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for threads.create not implemented (got params: {:?})", params)) }
        "threads.continue" => { let params: ThreadsContinueParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for threads.continue not implemented (got params: {:?})", params)) }
        "threads.fork" => { let params: ThreadsForkParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for threads.fork not implemented (got params: {:?})", params)) }
        "threads.get" => { let params: ThreadsGetParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for threads.get not implemented (got params: {:?})", params)) }
        "turns.run" => { let params: TurnsRunParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for turns.run not implemented (got params: {:?})", params)) }
        "approval.respond" => { let params: ApprovalRespondParams = serde_json::from_str(raw).map_err(|e| e.to_string())?; Err(format!("handler for approval.respond not implemented (got params: {:?})", params)) }
        _ => Err(format!("unknown method: {method}")),
    }
}
