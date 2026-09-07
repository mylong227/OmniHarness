//! 手写 N-API 胶水：运行时从宿主 node.exe 动态解析 `napi_*` 符号。
//!
//! 为什么不用 napi-sys / napi-rs：它们需要链接 node.lib（MSVC 格式导入库），
//! GNU 工具链下折腾成本高。这里用 `GetProcAddress` 动态解析，只依赖 kernel32，
//! mingw 直接可编——是 #64 发现的「windows-sys + GNU 无需 MSVC」认知的延伸。
//!
//! 注意：addon 内分配的内存只由 Rust 侧分配/释放（两段式字符串读取、new_string
//! 由 Node 复制走），绝不跨 CRT 传 malloc 指针，避免 mingw CRT 与 node CRT 混用崩溃。

use std::ffi::c_char;
use std::ffi::CStr;
use std::os::raw::c_void;
use std::sync::OnceLock;

use windows_sys::core::PCSTR;
use windows_sys::Win32::Foundation::{FARPROC, HMODULE};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

/// napi_status（N-API 约定 0 = napi_ok）。
pub const NAPI_OK: i32 = 0;

/// 不透明句柄（均为指针大小）。
pub type NapiEnv = *mut c_void;
pub type NapiValue = *mut c_void;
pub type NapiCallbackInfo = *mut c_void;
pub type NapiStatus = i32;
/// JS 函数回调：`fn(env, info) -> napi_value`。
pub type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

/// 运行时解析出的 napi 函数表（进程内只解析一次）。
#[repr(C)]
pub struct NapiTable {
    pub get_cb_info: unsafe extern "C" fn(
        NapiEnv,
        NapiCallbackInfo,
        *mut usize,
        *mut NapiValue,
        *mut NapiValue,
        *mut *mut c_void,
    ) -> NapiStatus,
    pub get_value_string_utf8:
        unsafe extern "C" fn(NapiEnv, NapiValue, *mut c_char, usize, *mut usize) -> NapiStatus,
    pub create_string_utf8:
        unsafe extern "C" fn(NapiEnv, *const c_char, usize, *mut NapiValue) -> NapiStatus,
    pub create_function: unsafe extern "C" fn(
        NapiEnv,
        *const c_char,
        usize,
        NapiCallback,
        *mut c_void,
        *mut NapiValue,
    ) -> NapiStatus,
    pub set_named_property:
        unsafe extern "C" fn(NapiEnv, NapiValue, *const c_char, NapiValue) -> NapiStatus,
    pub throw_error: unsafe extern "C" fn(NapiEnv, *const c_char, *const c_char) -> NapiStatus,
}

/// 动态解析单个符号；失败返回空指针。
fn resolve(module: HMODULE, name: &CStr) -> *mut c_void {
    unsafe {
        let farproc: FARPROC = GetProcAddress(module, name.as_ptr() as PCSTR);
        match farproc {
            Some(f) => f as usize as *mut c_void,
            None => std::ptr::null_mut(),
        }
    }
}

/// 解析符号为指定函数指针类型；缺失即 panic（注册期 fail-fast，宁死不悄悄坏）。
unsafe fn resolve_fn<T>(module: HMODULE, name: &CStr) -> T {
    let ptr = resolve(module, name);
    assert!(!ptr.is_null(), "napi 符号缺失: {}", name.to_string_lossy());
    // 数据指针 ↔ 函数指针均为指针大小；transmute_copy 不校验 T 大小（调用方保证）。
    std::mem::transmute_copy(&ptr)
}

/// 获取（必要时解析）napi 函数表。
pub fn table() -> &'static NapiTable {
    static TABLE: OnceLock<NapiTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        assert!(!module.is_null(), "无法获取宿主模块句柄（node.exe）");
        unsafe {
            NapiTable {
                get_cb_info: resolve_fn(module, c"napi_get_cb_info"),
                get_value_string_utf8: resolve_fn(module, c"napi_get_value_string_utf8"),
                create_string_utf8: resolve_fn(module, c"napi_create_string_utf8"),
                create_function: resolve_fn(module, c"napi_create_function"),
                set_named_property: resolve_fn(module, c"napi_set_named_property"),
                throw_error: resolve_fn(module, c"napi_throw_error"),
            }
        }
    })
}

/// 读 JS string → Rust String（UTF-8；两段式：先查长、再读入自分配缓冲）。
pub fn get_string(env: NapiEnv, value: NapiValue) -> Option<String> {
    let t = table();
    unsafe {
        let mut len = 0usize;
        if (t.get_value_string_utf8)(env, value, std::ptr::null_mut(), 0, &mut len) != NAPI_OK {
            return None;
        }
        let mut buf = vec![0u8; len + 1];
        let mut written = 0usize;
        if (t.get_value_string_utf8)(
            env,
            value,
            buf.as_mut_ptr() as *mut c_char,
            buf.len(),
            &mut written,
        ) != NAPI_OK
        {
            return None;
        }
        buf.truncate(written);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }
}

/// 建 JS string 值（Node 侧复制走，我们的缓冲随之释放，无跨 CRT 所有权转移）。
pub fn new_string(env: NapiEnv, s: &str) -> NapiValue {
    let t = table();
    let mut out: NapiValue = std::ptr::null_mut();
    let status =
        unsafe { (t.create_string_utf8)(env, s.as_ptr() as *const c_char, s.len(), &mut out) };
    if status == NAPI_OK {
        out
    } else {
        std::ptr::null_mut()
    }
}

/// 抛 JS 异常并返回空值。
pub fn throw(env: NapiEnv, msg: &str) -> NapiValue {
    let t = table();
    let full = format!("OmniNapiError: {}", msg);
    unsafe {
        (t.throw_error)(env, std::ptr::null(), full.as_ptr() as *const c_char);
    }
    std::ptr::null_mut()
}
