//! omni-sdk-gen：由单源 protocol schema 生成 Rust 服务端类型与派发骨架。
//!
//! 对应蓝图「单源 schema 生成三端（TS/Python/Rust）」中的 Rust 端；
//! TS 侧实现见 `src/schema/codeGenerator.ts`。

pub mod generator;
pub mod schema;

pub use generator::SdkGen;
pub use schema::{FieldSchema, FieldType, MethodSchema, ProtocolSchema, StreamSchema};
