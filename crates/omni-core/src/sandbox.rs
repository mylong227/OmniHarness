//! 沙箱：策略级门禁（危险命令黑名单 + 工作区路径白名单）与平台后端接口。
//! OS 级隔离矩阵（Windows RestrictedToken / Linux Landlock）：Windows 侧已用
//! GNU 工具链 + windows-sys 落地（见 `restricted_token` 模块，运行时探测可用性），
//! 无需 MSVC；Linux Landlock 需内核原生 API，当前保留接口等待平台接入。

use std::path::{Path, PathBuf};

pub use crate::restricted_token::RestrictedTokenSandbox;

/// 待裁决动作。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxAction {
    /// 命令执行。
    Command { command: String },
    /// 文件访问。
    Path { path: String },
}

/// 沙箱裁决。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxDecision {
    /// 是否放行。
    pub allowed: bool,
    /// 拒绝理由（放行为 None）。
    pub reason: Option<String>,
}

impl SandboxDecision {
    /// 放行。
    pub fn allow() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    /// 拒绝（含理由）。
    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.into()),
        }
    }
}

/// 沙箱端口：一个后端一个类。
pub trait Sandbox: Send + Sync {
    /// 后端名（便于日志与自省）。
    fn name(&self) -> &str;
    /// 裁决动作（fail-closed：无法判定时拒绝）。
    fn check(&self, action: &SandboxAction) -> SandboxDecision;
}

/// 危险命令模式（对齐 TS `DangerousCommands`：零依赖的规范化子串匹配）。
pub struct DangerousCommands;

impl DangerousCommands {
    /// 默认危险模式（小写、已规范化空白的子串）。
    pub fn defaults() -> &'static [&'static str] {
        &[
            "rm -rf",
            "rm -fr",
            "rm -r f",
            "rmdir /s",
            "rd /s",
            "del /s",
            "erase /s",
            "format c:",
            "format d:",
            "mkfs",
            "diskpart",
            "fdisk",
            "shutdown",
            "reg delete",
            "dd if=",
            // 下载后直接管道执行（规范化后管道两侧空格已折叠）。
            "|sh",
            "|bash",
            "|powershell",
            "|cmd",
        ]
    }

    /// 规范化命令：小写 + 折叠空白 + 去管道两侧空格。
    pub fn normalize(command: &str) -> String {
        let lowered = command.to_lowercase();
        let collapsed: String = lowered.split_whitespace().collect::<Vec<&str>>().join(" ");
        collapsed.replace(" | ", "|")
    }

    /// 是否命中危险模式。
    pub fn is_dangerous(command: &str) -> Option<&'static str> {
        let normalized = Self::normalize(command);
        Self::defaults()
            .iter()
            .copied()
            .find(|pattern| normalized.contains(pattern))
    }
}

/// 策略沙箱：危险命令黑名单 + 工作区路径白名单（对齐 TS `PolicySandbox`）。
pub struct PolicySandbox {
    workspace_root: PathBuf,
    extra_patterns: Vec<String>,
}

impl PolicySandbox {
    /// 以工作区根构造。
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            extra_patterns: Vec::new(),
        }
    }

    /// 追加自定义危险模式。
    pub fn with_extra_pattern(mut self, pattern: impl Into<String>) -> Self {
        self.extra_patterns.push(pattern.into());
        self
    }

    /// 工作区根。
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    /// 命令门禁：命中危险模式即拒绝。
    fn check_command(&self, command: &str) -> SandboxDecision {
        if let Some(pattern) = DangerousCommands::is_dangerous(command) {
            return SandboxDecision::deny(format!("命中危险命令规则: {}", pattern));
        }
        let normalized = DangerousCommands::normalize(command);
        for pattern in &self.extra_patterns {
            if normalized.contains(pattern.as_str()) {
                return SandboxDecision::deny(format!("命中自定义规则: {}", pattern));
            }
        }
        SandboxDecision::allow()
    }

    /// 路径门禁：工作区外即拒绝。
    fn check_path(&self, path: &str) -> SandboxDecision {
        match is_inside(&self.workspace_root, Path::new(path)) {
            true => SandboxDecision::allow(),
            false => SandboxDecision::deny(format!("路径越界: {}", path)),
        }
    }
}

impl Sandbox for PolicySandbox {
    fn name(&self) -> &str {
        "policy"
    }

    fn check(&self, action: &SandboxAction) -> SandboxDecision {
        match action {
            SandboxAction::Command { command } => self.check_command(command),
            SandboxAction::Path { path } => self.check_path(path),
        }
    }
}

/// 平台后端：把命令包装进 OS 级沙箱（返回包装后的命令行）。
/// - Linux: bwrap
/// - macOS: sandbox-exec
/// - Windows: RestrictedToken（GNU + windows-sys 实现，运行时探测可用性）
pub trait PlatformSandbox: Send + Sync {
    /// 后端名。
    fn name(&self) -> &str;
    /// 是否在本机可用。
    fn available(&self) -> bool;
    /// 包装命令；不可用返回 None（调用方应退回策略沙箱或拒绝）。
    fn wrap(&self, command: &str) -> Option<String>;
}

/// Linux bwrap 后端（纯命令包装，无 FFI）。
pub struct BwrapSandbox;

impl PlatformSandbox for BwrapSandbox {
    fn name(&self) -> &str {
        "bwrap"
    }

    fn available(&self) -> bool {
        cfg!(target_os = "linux")
    }

    fn wrap(&self, command: &str) -> Option<String> {
        match self.available() {
            true => Some(format!(
                "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net sh -c {:?}",
                command
            )),
            false => None,
        }
    }
}

/// macOS sandbox-exec 后端（纯命令包装，无 FFI）。
pub struct SeatbeltSandbox;

impl PlatformSandbox for SeatbeltSandbox {
    fn name(&self) -> &str {
        "seatbelt"
    }

    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn wrap(&self, command: &str) -> Option<String> {
        match self.available() {
            true => Some(format!(
                "sandbox-exec -p '(version 1)(allow default)(deny network*)' sh -c {:?}",
                command
            )),
            false => None,
        }
    }
}

/// 判断路径是否位于根内（防目录穿越：规范后比较前缀）。
pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    let Ok(root) = dunce_canonicalize_lossy(root) else {
        return false;
    };
    let Ok(candidate) = dunce_canonicalize_lossy(candidate) else {
        return false;
    };
    candidate == root || candidate.starts_with(&root)
}

/// 路径规范化：存在则 canonicalize，不存在则用其父目录 canonicalize + 文件名拼接。
fn dunce_canonicalize_lossy(path: &Path) -> std::io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(canonical) => Ok(canonical),
        Err(_) => {
            let file_name = path.file_name().map(|n| n.to_owned());
            let parent = path.parent().unwrap_or(Path::new("."));
            let canonical_parent = std::fs::canonicalize(parent)?;
            match file_name {
                Some(name) => Ok(canonical_parent.join(name)),
                None => Ok(canonical_parent),
            }
        }
    }
}
