//! omni-napi：把 omni-core 编译为 Node 原生插件（N-API / .node）。
//!
//! 核心设计（#65 FFI 下沉）：
//! - 手写 N-API 胶水：`napi_*` 符号运行时用 GetProcAddress 从宿主 node.exe 动态解析，
//!   不链接 node.lib、不依赖 napi-sys —— GNU 工具链（mingw）即可编译，**无需 MSVC**。
//! - TS 侧零新增运行时依赖：Node 内置 `require()` 加载 .node，不走任何第三方 FFI 库，
//!   维持「TS 零运行时依赖」铁律。
//! - 与 omni-wasm 同一套 JSON-RPC 面，但 native 版具备完整系统 API（真实时钟/进程/沙箱）。
//!
//! 构建：`cargo build --profile ffi -p omni-napi` → `target/ffi/omni_napi.dll`，
//! 复制为 `native/omni_napi.node` 供 Node 加载。
//!
//! 平台边界（2026-09-25 钉死）：本 crate 是 **Windows 专属**——napi_glue 经
//! `GetModuleHandleW/GetProcAddress` 从 node.exe 动态解析符号，handler/受限令牌/作业对象
//! 全部基于 Win32。非 Windows 平台本 crate 编译为空（`#![cfg(windows)]`），
//! `cargo test --workspace` / `clippy -D warnings` 在 ubuntu 首跑实证需此门控。

#![cfg(windows)]

mod handler;
mod napi_glue;

use napi_glue::{table, NapiEnv, NapiValue};

/// N-API 模块注册入口：Node 加载 .node 时调用，向 exports 挂方法。
///
/// # Safety
/// 由 Node 运行时在加载原生插件时调用；`env` 与 `exports` 必须是本次加载会话中
/// N-API 传入的有效句柄，且不得在调用返回后继续使用。函数内部不持有也不转移其所有权。
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let t = table();
    let mut call_fn: NapiValue = std::ptr::null_mut();
    let status = (t.create_function)(
        env,
        c"call".as_ptr(),
        4,
        handler::call_cb,
        std::ptr::null_mut(),
        &mut call_fn,
    );
    if status == napi_glue::NAPI_OK {
        (t.set_named_property)(env, exports, c"call".as_ptr(), call_fn);
    }
    exports
}
