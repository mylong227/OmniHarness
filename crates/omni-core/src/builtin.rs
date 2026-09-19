//! 内置工具集：Rust 内核出厂自带的能力，全部纯逻辑 / 受沙箱约束。
//!
//! 设计原则（fail-closed）：
//! - 文件类工具只允许访问指定白名单根目录（默认当前工作目录），越界一律拒绝；
//! - `shell.run`（仅 native 构建注册）执行外部命令，属于危险工具，必须配合
//!   审批门禁 + 策略沙箱 + OS 级沙箱（RestrictedToken/bwrap）使用；
//! - 每个工具附带 `ToolMeta`（name/description/参数 schema），供自省与权限判定。

use std::path::{Component, Path, PathBuf};

use crate::tool::{Tool, ToolArgs, ToolMeta, ToolResult};

/// 参数 JSON schema 的便捷构造：字段名 → (type, required, description)。
fn param_schema(fields: &[(&str, &str, bool, &str)]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (name, ty, required, desc) in fields {
        map.insert(
            name.to_string(),
            serde_json::json!({ "type": ty, "required": required, "description": desc }),
        );
    }
    serde_json::Value::Object(map)
}

/// 从参数中取字符串字段。
fn arg_str(args: &ToolArgs, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// 规范化路径：消解 "." 与 ".."，不触盘（目标可不存在）。
/// 避免词法 `starts_with` 被 "../" 目录穿越绕过（绝对根 + 规范化双重保险）。
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 校验路径是否落在白名单根目录内（防目录穿越）。
fn within(root: &Path, candidate: &Path) -> bool {
    normalize(candidate).starts_with(normalize(root))
}

/// 内置工具：echo。纯逻辑，回显参数。
pub struct EchoTool;

impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        match arg_str(&args, "text") {
            Some(t) => ToolResult::ok(format!("echo: {}", t)),
            None => ToolResult::err("缺少 text 参数"),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "echo",
            "原样回显文本（用于验证工具路由）",
            param_schema(&[("text", "string", true, "要回显的文本")]),
        )
    }
}

/// 内置工具：now。返回当前时间（native 秒级；wasm 用计数器）。
pub struct NowTool;

impl Tool for NowTool {
    fn name(&self) -> &str {
        "now"
    }
    fn call(&self, _args: ToolArgs) -> ToolResult {
        ToolResult::ok(crate::event::now_iso())
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new("now", "返回当前时间（ISO8601 近似）", param_schema(&[]))
    }
}

/// 内置工具：math.eval。纯逻辑算术求值（支持 + - * / () 与数字）。
pub struct MathEvalTool;

impl MathEvalTool {
    /// 简易四则运算求值器（无依赖；不支持乘方/变量）。
    fn eval(expr: &str) -> Option<f64> {
        let trimmed = expr.trim();
        if trimmed.is_empty() {
            return None;
        }
        Self::parse_expr(trimmed).map(|(v, rest)| if rest.trim().is_empty() { v } else { f64::NAN })
    }

    /// 递归下降：加法层。
    fn parse_expr(s: &str) -> Option<(f64, &str)> {
        let (mut left, mut rest) = Self::parse_term(s)?;
        loop {
            rest = rest.trim_start();
            if let Some(r) = rest.strip_prefix('+') {
                let (right, after) = Self::parse_term(r)?;
                left += right;
                rest = after;
            } else if let Some(r) = rest.strip_prefix('-') {
                let (right, after) = Self::parse_term(r)?;
                left -= right;
                rest = after;
            } else {
                return Some((left, rest));
            }
        }
    }

    /// 乘法层。
    fn parse_term(s: &str) -> Option<(f64, &str)> {
        let (mut left, mut rest) = Self::parse_factor(s)?;
        loop {
            rest = rest.trim_start();
            if let Some(r) = rest.strip_prefix('*') {
                let (right, after) = Self::parse_factor(r)?;
                left *= right;
                rest = after;
            } else if let Some(r) = rest.strip_prefix('/') {
                let (right, after) = Self::parse_factor(r)?;
                if right == 0.0 {
                    return None;
                }
                left /= right;
                rest = after;
            } else {
                return Some((left, rest));
            }
        }
    }

    /// 因子层：数字、括号表达式或一元负号。
    fn parse_factor(s: &str) -> Option<(f64, &str)> {
        let s = s.trim_start();
        // 一元负号：-3 / -(1+2) / 1 + -2
        if let Some(r) = s.strip_prefix('-') {
            let (v, after) = Self::parse_factor(r)?;
            return Some((-v, after));
        }
        if let Some(r) = s.strip_prefix('(') {
            let (v, after) = Self::parse_expr(r)?;
            let after = after.trim_start().strip_prefix(')')?;
            return Some((v, after));
        }
        let end = s
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(s.len());
        if end == 0 {
            return None;
        }
        let num: f64 = s[..end].parse().ok()?;
        Some((num, &s[end..]))
    }
}

impl Tool for MathEvalTool {
    fn name(&self) -> &str {
        "math.eval"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        match arg_str(&args, "expression") {
            Some(expr) => match Self::eval(&expr) {
                Some(v) if v.is_finite() => ToolResult::ok(v.to_string()),
                _ => ToolResult::err(format!("无法求值: {}", expr)),
            },
            None => ToolResult::err("缺少 expression 参数"),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "math.eval",
            "求值四则算术表达式（+ - * / 与括号）",
            param_schema(&[("expression", "string", true, "算术表达式")]),
        )
    }
}

/// 内置工具：fs.read_file。受沙箱白名单约束（只读，越界拒绝）。
pub struct ReadFileTool {
    root: PathBuf,
}

impl ReadFileTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "fs.read_file"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        let path = match arg_str(&args, "path") {
            Some(p) => p,
            None => return ToolResult::err("缺少 path 参数"),
        };
        let candidate = self.root.join(&path);
        if !within(&self.root, &candidate) {
            return ToolResult::err("路径超出沙箱白名单");
        }
        match std::fs::read_to_string(candidate) {
            Ok(content) => ToolResult::ok(content),
            Err(e) => ToolResult::err(format!("读取失败: {}", e)),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "fs.read_file",
            "读取白名单内文件内容（只读沙箱）",
            param_schema(&[("path", "string", true, "相对白名单根的文件路径")]),
        )
    }
}

/// 内置工具：fs.write_file。受沙箱白名单约束（越界拒绝）。
pub struct WriteFileTool {
    root: PathBuf,
}

impl WriteFileTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "fs.write_file"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        let path = match arg_str(&args, "path") {
            Some(p) => p,
            None => return ToolResult::err("缺少 path 参数"),
        };
        let content = arg_str(&args, "content").unwrap_or_default();
        let candidate = self.root.join(&path);
        if !within(&self.root, &candidate) {
            return ToolResult::err("路径超出沙箱白名单");
        }
        match std::fs::write(candidate, content) {
            Ok(_) => ToolResult::ok("已写入"),
            Err(e) => ToolResult::err(format!("写入失败: {}", e)),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "fs.write_file",
            "写入白名单内文件（受沙箱约束）",
            param_schema(&[
                ("path", "string", true, "相对白名单根的文件路径"),
                ("content", "string", false, "文件内容"),
            ]),
        )
    }
}

/// 内置工具：fs.list_dir。受沙箱白名单约束，返回目录条目（名字/类型/大小）。
pub struct ListDirTool {
    root: PathBuf,
}

impl ListDirTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "fs.list_dir"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        let raw = arg_str(&args, "path").unwrap_or_default();
        // 空或 "." 表示白名单根本身。
        let candidate: PathBuf = if raw.trim().is_empty() || raw.trim() == "." {
            self.root.clone()
        } else {
            self.root.join(&raw)
        };
        if !within(&self.root, &candidate) {
            return ToolResult::err("路径超出沙箱白名单");
        }
        match std::fs::read_dir(candidate) {
            Ok(entries) => {
                let mut items: Vec<serde_json::Value> = Vec::new();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let file_type = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    items.push(serde_json::json!({
                        "name": name,
                        "type": if file_type { "dir" } else { "file" },
                        "size": size,
                    }));
                }
                items.sort_by(|a, b| {
                    a["name"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["name"].as_str().unwrap_or(""))
                });
                ToolResult::ok(serde_json::to_string(&items).unwrap_or_default())
            }
            Err(e) => ToolResult::err(format!("列举目录失败: {}", e)),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "fs.list_dir",
            "列举白名单内目录条目（名字/类型/大小，JSON）",
            param_schema(&[("path", "string", false, "目录路径，默认白名单根")]),
        )
    }
}

/// 内置工具：shell.run。执行外部命令（wasm 构建下不可用）。
/// 危险工具：不设白名单，执行任意命令，必须配合 审批 + 策略沙箱 + OS 沙箱 使用。
/// 命令若被 OS 级沙箱包装，`command` 参数已由执行链替换为包装后的命令行。
pub struct ShellRunTool;

impl Tool for ShellRunTool {
    fn name(&self) -> &str {
        "shell.run"
    }
    fn call(&self, args: ToolArgs) -> ToolResult {
        let Some(command) = arg_str(&args, "command") else {
            return ToolResult::err("缺少 command 参数");
        };
        let output = run_shell(&command);
        match output {
            Ok(text) => ToolResult::ok(text),
            Err(e) => ToolResult::err(format!("执行失败: {}", e)),
        }
    }
    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "shell.run",
            "执行外部命令（危险工具，受审批与沙箱多层门禁约束）",
            param_schema(&[("command", "string", true, "要执行的命令")]),
        )
    }
}

/// 把子进程输出字节解码为字符串（**与 JS 侧 `OutputDecoder` 同策略**：先严格 UTF-8，再回退 OEM 码页）。
///
/// 为什么必须两段：子进程实际用哪个码页取决于它继承的控制台/管道——传统控制台是 OEM 码页
/// （中文 Windows 为 CP936/GBK），而 `chcp 65001`、Windows Terminal 与**受限令牌子进程**（实测）
/// 会输出 UTF-8。此前这里**只按 CP_OEMCP 解码**，于是 UTF-8 输出被当 GBK 二次解码：
/// 2026-09-19 实测 `echo 别名桥-ok` 经 `shell.run` 回传为 `鍒悕妗?ok`（同一命令走 JS 路径正常，
/// 因为 JS 侧 `OutputDecoder` 是「UTF-8 优先」⇒ 两条路径策略不一致，正是乱码的来源）。
fn decode_output(bytes: &[u8]) -> String {
    // 严格 UTF-8 校验：合法即采用（GBK 的字节序列几乎不可能整体构成合法 UTF-8）。
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::MultiByteToWideChar;
        // CP_OEMCP(=1)：让系统自动选用当前 OEM 代码页（中文 Windows 即 CP936/GBK），
        // 免去 GetOEMCP 取值，且与控制台实际输出编码一致。
        const CP_OEMCP: u32 = 1;
        let codepage = CP_OEMCP;
        let wide_len = unsafe {
            MultiByteToWideChar(
                codepage,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                std::ptr::null_mut(),
                0,
            )
        };
        if wide_len > 0 {
            let mut wide: Vec<u16> = vec![0u16; wide_len as usize];
            let written = unsafe {
                MultiByteToWideChar(
                    codepage,
                    0,
                    bytes.as_ptr(),
                    bytes.len() as i32,
                    wide.as_mut_ptr(),
                    wide_len,
                )
            };
            if written > 0 {
                return String::from_utf16_lossy(&wide[..written as usize]);
            }
        }
        // 回退：代码页未知或转换失败，按 lossy UTF-8（仍优于完全丢失）。
        String::from_utf8_lossy(bytes).into_owned()
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// 以系统 shell 执行命令并捕获输出（Windows: cmd /C；其余: sh -c）。
#[cfg(not(target_arch = "wasm32"))]
fn run_shell(command: &str) -> std::io::Result<String> {
    #[cfg(windows)]
    let output = if let Some(inner) =
        command.strip_prefix(crate::restricted_token::RESTRICTED_COMMAND_PREFIX)
    {
        // OS 沙箱包装：以进程内受限令牌 + Job Object 直拉命令（不依赖 omni-cli 外部二进制）。
        // 受限令牌由启动器构造期创建、调用方无法绕过——fail-closed。
        run_restricted_capture(inner)?
    } else {
        std::process::Command::new("cmd")
            .args(["/C", command])
            .output()?
    };
    #[cfg(not(windows))]
    let output = std::process::Command::new("sh")
        .args(["-c", command])
        .output()?;

    let stdout = decode_output(&output.stdout);
    let stderr = decode_output(&output.stderr);
    let combined = if stderr.is_empty() {
        stdout
    } else {
        format!("{}\n{}", stdout.trim_end(), stderr.trim_end())
    };
    if output.status.success() {
        Ok(combined.trim().to_string())
    } else {
        let code = output.status.code().unwrap_or(-1);
        Ok(format!("exit {}: {}", code, combined.trim()))
    }
}

/// 以进程内受限令牌 + Job Object 拉起命令并回传输出（A4：去掉 omni-cli 依赖）。
/// 启动器创建失败即返回 Err（fail-closed，绝不回退到无限制 cmd /C）。
/// 返回 `Output` 以复用 run_shell 后续统一的成功/退出码处理。
#[cfg(windows)]
fn run_restricted_capture(command: &str) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::ExitStatusExt;
    let launcher =
        crate::restricted_token::RestrictedProcessLauncher::new().map_err(std::io::Error::other)?;
    let (out, code) = launcher
        .run_capture(command)
        .map_err(std::io::Error::other)?;
    // 仅回传原始字节 + 退出码；成败前缀（"exit N:"）与解码统一由 run_shell 处理，
    // 与 cmd /C 分支完全一致，避免此处二次编码导致中文乱码。
    Ok(std::process::Output {
        status: ExitStatusExt::from_raw(code),
        stdout: out,
        stderr: Vec::new(),
    })
}

/// wasm 构建：无外部进程能力。
#[cfg(target_arch = "wasm32")]
fn run_shell(_command: &str) -> std::io::Result<String> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "wasm 环境不支持 shell.run",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_roundtrips_text() {
        let t = EchoTool;
        assert_eq!(t.call(serde_json::json!({"text": "hi"})).output, "echo: hi");
        assert!(!t.call(serde_json::json!({})).ok);
    }

    /// 回归：输出解码必须「先严格 UTF-8、再 OEM 回退」。
    ///
    /// 事故口径：受限令牌子进程实测输出 UTF-8（`echo 别名桥-ok` → `e5 88 ab …`），
    /// 而旧实现只按 CP_OEMCP 解码 ⇒ 中文回传成 `鍒悕妗?ok`（且含不可逆的 `?`）。
    #[test]
    fn decode_output_prefers_utf8_and_falls_back_to_oem() {
        // UTF-8（现代控制台 / chcp 65001 / 受限令牌子进程）
        assert_eq!(decode_output("别名桥-ok".as_bytes()), "别名桥-ok");
        // ASCII 两条路径都必须一致
        assert_eq!(decode_output(b"plain"), "plain");
        // GBK（传统中文控制台）只在 Windows 上能靠 OEM 码页还原；非 Windows 无 OEM 码页概念
        #[cfg(windows)]
        {
            let gbk: [u8; 9] = [0xb1, 0xf0, 0xc3, 0xfb, 0xc7, 0xc5, 0x2d, 0x6f, 0x6b];
            assert_eq!(decode_output(&gbk), "别名桥-ok");
        }
    }

    #[test]
    fn now_returns_nonempty() {
        let t = NowTool;
        assert!(!t.call(serde_json::json!({})).output.is_empty());
    }

    #[test]
    fn math_eval_supports_operators() {
        let t = MathEvalTool;
        assert_eq!(
            t.call(serde_json::json!({"expression": "1 + 2 * 3"}))
                .output,
            "7"
        );
        assert_eq!(
            t.call(serde_json::json!({"expression": "(1 + 2) * 3"}))
                .output,
            "9"
        );
        assert_eq!(
            t.call(serde_json::json!({"expression": "10 / 4"})).output,
            "2.5"
        );
        assert!(!t.call(serde_json::json!({"expression": "1 / 0"})).ok);
        assert!(!t.call(serde_json::json!({"expression": "abc"})).ok);
    }

    #[test]
    fn math_eval_supports_unary_minus() {
        let t = MathEvalTool;
        assert_eq!(
            t.call(serde_json::json!({"expression": "-3 + 5"})).output,
            "2"
        );
        assert_eq!(
            t.call(serde_json::json!({"expression": "-(1 + 2)"})).output,
            "-3"
        );
        assert_eq!(
            t.call(serde_json::json!({"expression": "1 + -2"})).output,
            "-1"
        );
    }

    #[test]
    fn list_dir_lists_entries_within_root() {
        // 用临时目录验证目录列举：建一个文件 + 一个子目录。
        let tmp = std::env::temp_dir().join(format!("omni_listdir_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let _ = std::fs::write(tmp.join("a.txt"), "x");
        let _ = std::fs::create_dir_all(tmp.join("sub"));
        let t = ListDirTool::new(tmp.clone());
        let res = t.call(serde_json::json!({}));
        assert!(res.ok, "默认列出白名单根");
        let items: Vec<serde_json::Value> = serde_json::from_str(&res.output).unwrap_or_default();
        let names: Vec<&str> = items.iter().filter_map(|i| i["name"].as_str()).collect();
        assert!(names.contains(&"a.txt"), "应列出文件");
        assert!(names.contains(&"sub"), "应列出子目录");
        let sub = items.iter().find(|i| i["name"] == "sub").unwrap();
        assert_eq!(sub["type"], "dir");
        let file = items.iter().find(|i| i["name"] == "a.txt").unwrap();
        assert_eq!(file["type"], "file");
        assert_eq!(file["size"], 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_rejects_outside_root() {
        let t = ListDirTool::new(PathBuf::from("C:/sandbox"));
        let res = t.call(serde_json::json!({"path": "../"}));
        assert!(!res.ok, "越界应拒绝");
        assert!(res.error.unwrap_or_default().contains("沙箱"));
    }

    #[test]
    fn read_file_rejects_outside_root() {
        let root = PathBuf::from("C:/sandbox");
        let t = ReadFileTool::new(root);
        let res = t.call(serde_json::json!({"path": "C:/Windows/system32/win.ini"}));
        assert!(!res.ok, "越界应拒绝");
        assert!(res.error.unwrap_or_default().contains("沙箱"));
    }

    #[test]
    fn write_file_rejects_outside_root() {
        let root = PathBuf::from("C:/sandbox");
        let t = WriteFileTool::new(root);
        let res = t.call(serde_json::json!({"path": "../escape.txt"}));
        assert!(!res.ok);
    }

    #[test]
    fn read_write_roundtrip_within_root() {
        // 用临时目录验证白名单内读写。
        let tmp = std::env::temp_dir().join(format!("omni_builtin_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let path = tmp.join("note.txt");
        let w = WriteFileTool::new(tmp.clone());
        assert!(
            w.call(serde_json::json!({"path": path.to_str().unwrap(), "content": "hello"}))
                .ok
        );
        let r = ReadFileTool::new(tmp.clone());
        assert_eq!(
            r.call(serde_json::json!({"path": path.to_str().unwrap()}))
                .output,
            "hello"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tools_expose_metadata() {
        assert_eq!(EchoTool.meta().name, "echo");
        assert!(!EchoTool.meta().description.is_empty());
        assert!(MathEvalTool.meta().param_schema.get("expression").is_some());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn shell_run_executes_command() {
        let tool = ShellRunTool;
        let res = tool.call(serde_json::json!({ "command": "echo omni-shell-ok" }));
        assert!(res.ok, "命令应执行成功: {:?}", res.error);
        assert!(
            res.output.contains("omni-shell-ok"),
            "输出应含回显: {:?}",
            res.output
        );
        let bad = tool.call(serde_json::json!({}));
        assert!(!bad.ok, "缺参数应报错");
    }
}
