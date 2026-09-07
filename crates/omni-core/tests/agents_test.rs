//! 多 Agent 树单元测试。

use omni_core::agents::{AgentError, AgentRegistry};

#[test]
fn root_registers_without_parent() {
    let mut registry = AgentRegistry::new();
    registry
        .register("main", "coordinator", None)
        .expect("注册根");
    assert_eq!(registry.roots(), vec!["main".to_string()]);
    assert_eq!(registry.role_of("main"), Some("coordinator"));
}

#[test]
fn child_requires_existing_parent() {
    let mut registry = AgentRegistry::new();
    let err = registry
        .register("w1", "worker", Some("missing"))
        .unwrap_err();
    assert_eq!(err, AgentError::UnknownParent("missing".to_string()));
}

#[test]
fn duplicate_id_is_rejected() {
    let mut registry = AgentRegistry::new();
    registry.register("a", "main", None).expect("首次注册");
    let err = registry.register("a", "main", None).unwrap_err();
    assert_eq!(err, AgentError::DuplicateId("a".to_string()));
}

#[test]
fn children_and_ancestors_are_resolved() {
    let mut registry = AgentRegistry::new();
    registry.register("root", "coordinator", None).expect("根");
    registry.register("w1", "worker", Some("root")).expect("子");
    registry.register("w2", "worker", Some("root")).expect("子");
    registry.register("w1a", "sub", Some("w1")).expect("孙");
    assert_eq!(
        registry.children_of("root"),
        vec!["w1".to_string(), "w2".to_string()]
    );
    assert_eq!(
        registry.ancestors_of("w1a"),
        vec!["w1".to_string(), "root".to_string()]
    );
    assert_eq!(registry.len(), 4);
}

#[test]
fn remove_subtree_drops_descendants() {
    let mut registry = AgentRegistry::new();
    registry.register("root", "coordinator", None).expect("根");
    registry.register("w1", "worker", Some("root")).expect("子");
    registry.register("w1a", "sub", Some("w1")).expect("孙");
    registry.register("w2", "worker", Some("root")).expect("子");
    let removed = registry.remove_subtree("w1");
    assert_eq!(removed, vec!["w1".to_string(), "w1a".to_string()]);
    assert!(registry.get("w1").is_none());
    assert!(registry.get("w1a").is_none());
    assert_eq!(registry.children_of("root"), vec!["w2".to_string()]);
}

#[test]
fn removing_unknown_id_is_noop() {
    let mut registry = AgentRegistry::new();
    assert!(registry.remove_subtree("nope").is_empty());
    assert!(registry.is_empty());
}
