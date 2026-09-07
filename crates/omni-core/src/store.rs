//! 会话持久化：append-only 事件日志（事实源）+ 读取 / 回放 / 续跑。
//! 对齐 Codex thread-store rollout JSONL 与 DSH「模型所见即所记」。

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::event::SessionEvent;

/// JSONL 会话存储：一行一事件，只追加不改写。
pub struct RolloutStore {
    path: PathBuf,
}

impl RolloutStore {
    /// 以文件路径构造（文件不存在时首次 append 自动创建）。
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一条事件。
    pub fn append(&self, event: &SessionEvent) -> std::io::Result<()> {
        self.append_all(std::slice::from_ref(event))
    }

    /// 批量追加事件（一次打开，顺序写入）。
    pub fn append_all(&self, events: &[SessionEvent]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        for event in events {
            writeln!(file, "{}", event.to_json())?;
        }
        file.flush()
    }

    /// 读取全部事件（跳过无法解析的行，保证回放健壮）。
    pub fn load(&self) -> std::io::Result<Vec<SessionEvent>> {
        match File::open(&self.path) {
            Ok(file) => Ok(parse_lines(BufReader::new(file))),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err),
        }
    }

    /// 回放：按写入顺序返回事件流（与 load 同序，语义化别名）。
    pub fn replay(&self) -> std::io::Result<Vec<SessionEvent>> {
        self.load()
    }
}

/// 内存事件存储：无文件系统环境（如 wasm、单测）使用。
#[derive(Debug, Default)]
pub struct MemoryStore {
    events: Vec<SessionEvent>,
}

impl MemoryStore {
    /// 空存储。
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    /// 追加一条事件。
    pub fn append(&mut self, event: &SessionEvent) {
        self.events.push(event.clone());
    }

    /// 批量追加。
    pub fn append_all(&mut self, events: &[SessionEvent]) {
        self.events.extend_from_slice(events);
    }

    /// 全部事件（只读）。
    pub fn all(&self) -> &[SessionEvent] {
        &self.events
    }

    /// 事件条数。
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

/// 逐行解析 JSONL，忽略空行与坏行。
fn parse_lines<R: BufRead>(reader: R) -> Vec<SessionEvent> {
    reader
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<SessionEvent>(&line).ok())
        .collect()
}
