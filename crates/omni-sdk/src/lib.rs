//! OmniHarness Rust SDK：接入运行中 harness 的客户端运行时。
//!
//! 传输：stdio（本地子进程 / app-server --stdio）与 TCP（常驻服务）。
//! 协议：JSON-RPC 2.0，一行一帧（对齐 TS `src/sdk/` 与 `src/server/lineTransport.ts`）。

pub mod client;
pub mod transport;

pub use client::{Notification, OmniClient, RpcError};
pub use transport::{ChildProcessTransport, StdioTransport, TcpTransport, Transport};
