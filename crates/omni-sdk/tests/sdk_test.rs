//! Rust SDK 端到端测试：起本地 TCP harness 桩，验证请求-响应与通知订阅。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

use omni_sdk::{OmniClient, RpcError, TcpTransport};

/// 启动一个最小 JSON-RPC 服务端桩，返回监听端口。
/// 行为：
/// - `boom` → 返回 error 对象；
/// - `subscribe` → 推送一条 `event` 通知，不回响应；
/// - 其余 → 回显 method 与 params。
fn spawn_stub_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
    let port = listener.local_addr().expect("端口").port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("接受连接");
        serve(stream);
    });
    port
}

/// 服务端主循环（单连接）。
fn serve(stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("克隆流"));
    let mut writer = stream;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let frame: serde_json::Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let method = frame
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if method == "subscribe" {
            let notification = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "event",
                "params": { "type": "tool_call", "name": "echo" },
            });
            let _ = writeln!(writer, "{}", notification);
            let _ = writer.flush();
            continue;
        }
        let response = if method == "boom" {
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": frame.get("id"),
                "error": { "code": -32001, "message": "服务端故意失败" },
            })
        } else {
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": frame.get("id"),
                "result": { "ok": true, "method": method, "params": frame.get("params") },
            })
        };
        let _ = writeln!(writer, "{}", response);
        let _ = writer.flush();
    }
}

fn connect(port: u16) -> OmniClient<TcpTransport> {
    let transport = TcpTransport::connect(("127.0.0.1", port)).expect("连接桩服务");
    OmniClient::new(transport)
}

#[test]
fn request_round_trips_over_tcp() {
    let port = spawn_stub_server();
    let mut client = connect(port);
    let result = client
        .request("session.start", serde_json::json!({ "sessionId": "s1" }))
        .expect("请求成功");
    assert_eq!(result["ok"], true);
    assert_eq!(result["method"], "session.start");
    assert_eq!(result["params"]["sessionId"], "s1");
}

#[test]
fn request_ids_increment_per_call() {
    let port = spawn_stub_server();
    let mut client = connect(port);
    // 连续三次请求若 id 错配会挂起或错配，全部成功即说明 id 递增匹配正确。
    for i in 0..3 {
        let result = client
            .request("ping", serde_json::json!({ "seq": i }))
            .expect("请求成功");
        assert_eq!(result["params"]["seq"], i);
    }
}

#[test]
fn remote_error_is_reported() {
    let port = spawn_stub_server();
    let mut client = connect(port);
    match client.request("boom", serde_json::json!({})) {
        Err(RpcError::Remote { code, message }) => {
            assert_eq!(code, -32001);
            assert_eq!(message, "服务端故意失败");
        }
        other => panic!("应返回 Remote 错误，实际 {:?}", other),
    }
}

#[test]
fn notification_subscription_receives_pushed_event() {
    let port = spawn_stub_server();
    let mut client = connect(port);
    client
        .notify("subscribe", serde_json::json!({}))
        .expect("订阅成功");
    let notification = client
        .read_notification()
        .expect("读取成功")
        .expect("收到通知");
    assert_eq!(notification.method, "event");
    assert_eq!(notification.params["type"], "tool_call");
}

#[test]
fn closed_connection_returns_none() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
    let port = listener.local_addr().expect("端口").port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("接受连接");
        drop(stream); // 立即关闭
    });
    let mut client = connect(port);
    let notification = client.read_notification().expect("读取成功");
    assert!(notification.is_none());
}
