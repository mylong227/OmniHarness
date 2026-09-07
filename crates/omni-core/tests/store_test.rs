//! 会话持久化单元测试。

use omni_core::event::{EventType, SessionEvent};
use omni_core::store::{MemoryStore, RolloutStore};

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("omni_store_{}_{}.jsonl", name, std::process::id()))
}

#[test]
fn rollout_appends_and_loads_in_order() {
    let path = temp_path("append");
    let _ = std::fs::remove_file(&path);
    let store = RolloutStore::new(&path);
    let events = vec![
        SessionEvent::tool_call("s1", "c1", "echo", serde_json::json!({ "text": "a" })),
        SessionEvent::tool_result("s1", "c1", true, "out-a"),
    ];
    store.append_all(&events).expect("写入成功");
    let loaded = store.load().expect("读取成功");
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].r#type, EventType::ToolCall);
    assert_eq!(loaded[1].payload["output"], "out-a");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn rollout_replays_after_reopen() {
    let path = temp_path("replay");
    let _ = std::fs::remove_file(&path);
    let store = RolloutStore::new(&path);
    store
        .append(&SessionEvent::tool_call(
            "s1",
            "c1",
            "echo",
            serde_json::json!({}),
        ))
        .expect("写入成功");
    // 重新打开（模拟进程重启）后回放。
    let reopened = RolloutStore::new(&path);
    let replayed = reopened.replay().expect("回放成功");
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].payload["name"], "echo");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn missing_file_loads_as_empty() {
    let path = temp_path("missing");
    let _ = std::fs::remove_file(&path);
    let store = RolloutStore::new(&path);
    assert!(store.load().expect("缺文件返回空").is_empty());
}

#[test]
fn broken_lines_are_skipped() {
    let path = temp_path("broken");
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, "not-json\n\n").expect("写入坏行");
    let store = RolloutStore::new(&path);
    assert!(store.load().expect("坏行被跳过").is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn memory_store_tracks_events() {
    let mut store = MemoryStore::new();
    assert!(store.is_empty());
    store.append(&SessionEvent::tool_call(
        "s1",
        "c1",
        "echo",
        serde_json::json!({}),
    ));
    assert_eq!(store.len(), 1);
    assert_eq!(store.all()[0].session_id, "s1");
}
