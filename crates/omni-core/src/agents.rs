//! 多 Agent 树：registry + 角色 + 父子关系（对齐 Codex `agent/control.rs` 简化版）。

use std::collections::HashMap;

/// Agent 注册错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    /// 重复 ID。
    DuplicateId(String),
    /// 父节点不存在。
    UnknownParent(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentError::DuplicateId(id) => write!(f, "agent 已存在: {}", id),
            AgentError::UnknownParent(id) => write!(f, "父 agent 不存在: {}", id),
        }
    }
}

impl std::error::Error for AgentError {}

/// Agent 树节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentNode {
    /// Agent ID。
    pub id: String,
    /// 角色（如 `main` / `worker` / `reviewer`）。
    pub role: String,
    /// 父节点 ID（根节点为 None）。
    pub parent: Option<String>,
}

/// Agent 注册表：管理多 agent 树的父子关系与角色。
#[derive(Debug, Default)]
pub struct AgentRegistry {
    nodes: HashMap<String, AgentNode>,
}

impl AgentRegistry {
    /// 空注册表。
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    /// 注册一个 agent；父 ID 必须已存在（根传 None）。
    pub fn register(
        &mut self,
        id: impl Into<String>,
        role: impl Into<String>,
        parent: Option<&str>,
    ) -> Result<(), AgentError> {
        let id = id.into();
        if self.nodes.contains_key(&id) {
            return Err(AgentError::DuplicateId(id));
        }
        if let Some(parent) = parent {
            if !self.nodes.contains_key(parent) {
                return Err(AgentError::UnknownParent(parent.to_string()));
            }
        }
        self.nodes.insert(
            id.clone(),
            AgentNode {
                id,
                role: role.into(),
                parent: parent.map(|p| p.to_string()),
            },
        );
        Ok(())
    }

    /// 取节点。
    pub fn get(&self, id: &str) -> Option<&AgentNode> {
        self.nodes.get(id)
    }

    /// 取角色。
    pub fn role_of(&self, id: &str) -> Option<&str> {
        self.nodes.get(id).map(|n| n.role.as_str())
    }

    /// 直接子节点（按 ID 排序，保证输出稳定）。
    pub fn children_of(&self, id: &str) -> Vec<String> {
        let mut children: Vec<String> = self
            .nodes
            .values()
            .filter(|n| n.parent.as_deref() == Some(id))
            .map(|n| n.id.clone())
            .collect();
        children.sort();
        children
    }

    /// 根节点列表（按 ID 排序）。
    pub fn roots(&self) -> Vec<String> {
        let mut roots: Vec<String> = self
            .nodes
            .values()
            .filter(|n| n.parent.is_none())
            .map(|n| n.id.clone())
            .collect();
        roots.sort();
        roots
    }

    /// 祖先链（由父到根）。
    pub fn ancestors_of(&self, id: &str) -> Vec<String> {
        let mut chain = Vec::new();
        let mut cursor = self.nodes.get(id).and_then(|n| n.parent.clone());
        while let Some(parent) = cursor {
            chain.push(parent.clone());
            cursor = self.nodes.get(&parent).and_then(|n| n.parent.clone());
        }
        chain
    }

    /// 移除节点及其全部后代，返回被移除的 ID（按 ID 排序）。
    pub fn remove_subtree(&mut self, id: &str) -> Vec<String> {
        if !self.nodes.contains_key(id) {
            return Vec::new();
        }
        let mut removed = vec![id.to_string()];
        let mut index = 0usize;
        while index < removed.len() {
            let current = removed[index].clone();
            for child in self.children_of(&current) {
                removed.push(child);
            }
            index += 1;
        }
        removed.sort();
        for id in &removed {
            self.nodes.remove(id);
        }
        removed
    }

    /// 节点数。
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}
