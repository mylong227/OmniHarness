//! 传输层：一行一帧的 JSON 通道（对齐 TS `lineTransport.ts` 的 JSONL 分帧）。
//! stdio 用于本地子进程 / app-server --stdio；TCP 用于常驻服务与远端网关。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// 传输端口：一行一帧，双向。
pub trait Transport {
    /// 发送一行 JSON。
    fn send_line(&mut self, line: &str) -> std::io::Result<()>;
    /// 接收一行 JSON；返回 None 表示通道已关闭。
    fn recv_line(&mut self) -> std::io::Result<Option<String>>;
}

/// stdio 传输：读 stdin、写 stdout（每行一帧）。
pub struct StdioTransport {
    reader: BufReader<std::io::Stdin>,
}

impl StdioTransport {
    /// 构造（绑定进程标准输入）。
    pub fn new() -> Self {
        Self {
            reader: BufReader::new(std::io::stdin()),
        }
    }
}

impl Default for StdioTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for StdioTransport {
    fn send_line(&mut self, line: &str) -> std::io::Result<()> {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        writeln!(handle, "{}", line)?;
        handle.flush()
    }

    fn recv_line(&mut self) -> std::io::Result<Option<String>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line)? {
            0 => Ok(None),
            _ => Ok(Some(line.trim_end().to_string())),
        }
    }
}

/// TCP 传输：连接常驻 harness（同一连接上双向分帧）。
pub struct TcpTransport {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl TcpTransport {
    /// 连接指定地址（阻塞）。
    pub fn connect(addr: impl ToSocketAddrs) -> std::io::Result<Self> {
        let stream = TcpStream::connect(addr)?;
        let reader = BufReader::new(stream.try_clone()?);
        Ok(Self {
            reader,
            writer: stream,
        })
    }
}

impl Transport for TcpTransport {
    fn send_line(&mut self, line: &str) -> std::io::Result<()> {
        writeln!(self.writer, "{}", line)?;
        self.writer.flush()
    }

    fn recv_line(&mut self) -> std::io::Result<Option<String>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line)? {
            0 => Ok(None),
            _ => Ok(Some(line.trim_end().to_string())),
        }
    }
}

/// 子进程 stdio 传输：启动常驻 harness（如 `omniharness server`）并接管其 stdin/stdout。
pub struct ChildProcessTransport {
    child: Child,
    reader: BufReader<ChildStdout>,
    writer: ChildStdin,
}

impl ChildProcessTransport {
    /// 启动子进程并建立行式通道。
    pub fn spawn(program: &str, args: &[&str]) -> std::io::Result<Self> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("子进程 stdout 不可用"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("子进程 stdin 不可用"))?;
        Ok(Self {
            child,
            reader: BufReader::new(stdout),
            writer: stdin,
        })
    }
}

impl Drop for ChildProcessTransport {
    /// 关闭通道：先杀后收，避免僵尸进程。
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Transport for ChildProcessTransport {
    fn send_line(&mut self, line: &str) -> std::io::Result<()> {
        writeln!(self.writer, "{}", line)?;
        self.writer.flush()
    }

    fn recv_line(&mut self) -> std::io::Result<Option<String>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line)? {
            0 => Ok(None),
            _ => Ok(Some(line.trim_end().to_string())),
        }
    }
}
