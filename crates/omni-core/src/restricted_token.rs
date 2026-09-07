//! Windows RestrictedToken 沙箱后端。
//! 实现：受限令牌（删特权）+ Job Object（资源限额 + 关句柄即杀）+ 受限进程启动。
//! 说明：走 windows-sys（mingw 链接 advapi32/kernel32），GNU 工具链即可编译，无需 MSVC。
//! `RestrictedTokenSandbox::available()` 为运行时探测（缓存结果），非写死常量。

use crate::sandbox::PlatformSandbox;

/// RestrictedToken 后端（跨平台导出；仅 Windows 下具备真实能力）。
pub struct RestrictedTokenSandbox;

/// OS 沙箱包装哨兵前缀：run_shell 识别此前缀后，以进程内受限令牌 + Job Object 直拉命令，
/// 不再依赖外部 `omni-cli` 二进制（A4：去掉 omni-cli 强依赖）。
pub const RESTRICTED_COMMAND_PREFIX: &str = "omni-restricted://";

impl PlatformSandbox for RestrictedTokenSandbox {
    fn name(&self) -> &str {
        "restricted-token"
    }

    fn available(&self) -> bool {
        restricted_token_available()
    }

    fn wrap(&self, command: &str) -> Option<String> {
        if !self.available() {
            return None;
        }
        // 受限启动由进程内 RestrictedProcessLauncher 直接完成（见 builtin.rs run_shell
        // 识别此前缀，以受限令牌 + Job Object 拉起 cmd /C，无需 omni-cli 外部二进制）。
        // 不加引号：run_shell 识别此前缀后剥离，原始命令原样交给受限启动器。
        Some(format!("{}{}", RESTRICTED_COMMAND_PREFIX, command))
    }
}

/// 受限进程启动器：创建受限令牌 + Job Object，并以受限令牌拉起子进程。
#[cfg(windows)]
pub struct RestrictedProcessLauncher {
    token: windows_sys::Win32::Foundation::HANDLE,
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl RestrictedProcessLauncher {
    /// 创建受限令牌与 Job Object（任一步失败即整体失败，fail-closed）。
    pub fn new() -> Result<Self, String> {
        let token = create_restricted_token()?;
        let job = create_job_object()?;
        Ok(Self { token, job })
    }

    /// 以受限令牌 + Job Object 启动命令并等待结束，返回进程退出码。
    pub fn run(&self, command: &str) -> Result<u32, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            CreateProcessAsUserW, GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
            INFINITE, PROCESS_INFORMATION, STARTUPINFOW,
        };

        // Windows 下经 cmd /C 执行：echo/dir 等 shell 内建命令并非可执行文件，
        // 直接 CreateProcessAsUserW 会「找不到文件」而失败；cmd /C 包裹后内建命令与
        // PATH 解析才生效，与 builtin.rs run_shell 的 Windows 分支行为一致。
        let cmdline_str = format!("cmd /C {}", command);
        let mut cmdline: Vec<u16> = cmdline_str.encode_utf16().chain(Some(0)).collect();
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut proc_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        let ok = unsafe {
            CreateProcessAsUserW(
                self.token,
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                0,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut proc_info,
            )
        };
        if ok == 0 {
            return Err(format!(
                "CreateProcessAsUserW 失败, win32 错误 {}",
                unsafe { GetLastError() }
            ));
        }

        // 挂进 Job Object：失败则终止进程并报错（fail-closed，不留未约束子进程）。
        let assigned = unsafe { AssignProcessToJobObject(self.job, proc_info.hProcess) };
        if assigned == 0 {
            unsafe {
                TerminateProcess(proc_info.hProcess, 1);
                CloseHandle(proc_info.hThread);
                CloseHandle(proc_info.hProcess);
            }
            return Err(format!(
                "AssignProcessToJobObject 失败, win32 错误 {}",
                unsafe { GetLastError() }
            ));
        }

        unsafe { CloseHandle(proc_info.hThread) };
        unsafe { WaitForSingleObject(proc_info.hProcess, INFINITE) };
        let mut exit_code: u32 = 0;
        unsafe { GetExitCodeProcess(proc_info.hProcess, &mut exit_code) };
        unsafe { CloseHandle(proc_info.hProcess) };
        Ok(exit_code)
    }

    /// 以受限令牌 + Job Object 启动命令并捕获 stdout，返回 (原始字节, 退出码)。
    /// 用于 shell.run 需回传命令输出的场景（[`Self::run`] 仅返回退出码）。
    /// 受限令牌由构造期创建、调用方无法绕过——天然 fail-closed，绝不回退无限制启动。
    /// 实现要点：以 `2>&1` 把 stderr 合并进 stdout，单管道在主线程顺序读取，
    /// 避免跨线程传递 HANDLE 的 Send 问题（HANDLE 是裸指针 `*mut c_void` 不满足 Send）。
    /// 只回传**原始字节**：最终解码交给调用方的 `decode_output`（与 `cmd /C` 分支一致，
    /// 避免此处先按 OEM 解码再被二次解码导致中文乱码）。
    pub fn run_capture(&self, command: &str) -> Result<(Vec<u8>, u32), String> {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
            INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Pipes::CreatePipe;
        use windows_sys::Win32::System::Threading::{
            CreateProcessAsUserW, GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
            INFINITE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
        };

        // 可继承管道：父进程读，子进程继承写端。单管道即可（stderr 经 2>&1 合并）。
        let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.bInheritHandle = 1;
        let mut out_read: HANDLE = INVALID_HANDLE_VALUE;
        let mut out_write: HANDLE = INVALID_HANDLE_VALUE;
        if unsafe { CreatePipe(&mut out_read, &mut out_write, &sa, 0) } == 0 {
            return Err(format!("CreatePipe 失败, win32 错误 {}", unsafe {
                GetLastError()
            }));
        }
        // 读端不继承给子进程，避免子进程残留读端句柄导致 EOF 误判。
        unsafe {
            SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);
        }

        // 2>&1：stderr 合并进 stdout，主线程读单管道即可完整捕获命令输出。
        let cmdline_str = format!("cmd /C {} 2>&1", command);
        let mut cmdline: Vec<u16> = cmdline_str.encode_utf16().chain(Some(0)).collect();
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdOutput = out_write;
        startup.hStdError = out_write;
        let mut proc_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        let ok = unsafe {
            CreateProcessAsUserW(
                self.token,
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                0,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut proc_info,
            )
        };
        // 父进程不再需要写端，立即关闭（子持有副本，EOF 由子退出触发）。
        unsafe {
            CloseHandle(out_write);
        }
        if ok == 0 {
            unsafe {
                CloseHandle(out_read);
            }
            return Err(format!(
                "CreateProcessAsUserW 失败, win32 错误 {}",
                unsafe { GetLastError() }
            ));
        }

        let assigned = unsafe { AssignProcessToJobObject(self.job, proc_info.hProcess) };
        if assigned == 0 {
            unsafe {
                TerminateProcess(proc_info.hProcess, 1);
                CloseHandle(proc_info.hThread);
                CloseHandle(proc_info.hProcess);
                CloseHandle(out_read);
            }
            return Err(format!(
                "AssignProcessToJobObject 失败, win32 错误 {}",
                unsafe { GetLastError() }
            ));
        }
        unsafe { CloseHandle(proc_info.hThread) };

        // 主线程顺序读单管道（先排空再等退出，避免子进程写满管道时死锁）。
        let stdout = read_pipe_to_bytes(out_read);

        unsafe { WaitForSingleObject(proc_info.hProcess, INFINITE) };
        let mut exit_code: u32 = 0;
        unsafe { GetExitCodeProcess(proc_info.hProcess, &mut exit_code) };
        unsafe { CloseHandle(proc_info.hProcess) };

        Ok((stdout, exit_code))
    }
}

/// 读完管道直至 EOF，累积原始字节（不解码——解码交给调用方的 `decode_output`）。
#[cfg(windows)]
fn read_pipe_to_bytes(handle: windows_sys::Win32::Foundation::HANDLE) -> Vec<u8> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    let mut buf = [0u8; 4096];
    let mut total: Vec<u8> = Vec::new();
    loop {
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                handle,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut bytes_read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || bytes_read == 0 {
            break;
        }
        total.extend_from_slice(&buf[..bytes_read as usize]);
    }
    unsafe { CloseHandle(handle) };
    total
}

#[cfg(windows)]
impl Drop for RestrictedProcessLauncher {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            // KILL_ON_JOB_CLOSE：job 句柄关闭即终止其内所有进程（含逃逸孙进程）。
            CloseHandle(self.job);
            CloseHandle(self.token);
        }
    }
}

/// 从当前进程令牌派生受限令牌（删全部特权），转成可分配的 primary 令牌。
#[cfg(windows)]
fn create_restricted_token() -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DuplicateTokenEx, SecurityImpersonation, TokenPrimary,
        DISABLE_MAX_PRIVILEGE, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut process_token: HANDLE = INVALID_HANDLE_VALUE;
    let ok = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY,
            &mut process_token,
        )
    };
    if ok == 0 {
        return Err(format!("OpenProcessToken 失败, win32 错误 {}", unsafe {
            GetLastError()
        }));
    }

    // DISABLE_MAX_PRIVILEGE：禁用全部特权（保留基本访问所需）。
    let mut restricted: HANDLE = INVALID_HANDLE_VALUE;
    let ok = unsafe {
        CreateRestrictedToken(
            process_token,
            DISABLE_MAX_PRIVILEGE,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            &mut restricted,
        )
    };
    unsafe { CloseHandle(process_token) };
    if ok == 0 {
        return Err(format!(
            "CreateRestrictedToken 失败, win32 错误 {}",
            unsafe { GetLastError() }
        ));
    }

    // CreateProcessAsUserW 要求 primary 令牌，转一份可分配的。
    let mut primary: HANDLE = INVALID_HANDLE_VALUE;
    let ok = unsafe {
        DuplicateTokenEx(
            restricted,
            TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
    };
    unsafe { CloseHandle(restricted) };
    if ok == 0 {
        return Err(format!("DuplicateTokenEx 失败, win32 错误 {}", unsafe {
            GetLastError()
        }));
    }
    Ok(primary)
}

/// 创建 Job Object：资源限额（内存/进程数）+ KILL_ON_JOB_CLOSE。
#[cfg(windows)]
fn create_job_object() -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job == INVALID_HANDLE_VALUE {
        return Err(format!("CreateJobObjectW 失败, win32 错误 {}", unsafe {
            GetLastError()
        }));
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    info.BasicLimitInformation.ActiveProcessLimit = 4;
    info.ProcessMemoryLimit = 256 * 1024 * 1024;
    info.JobMemoryLimit = 1024 * 1024 * 1024;

    let ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        unsafe { CloseHandle(job) };
        return Err(format!(
            "SetInformationJobObject 失败, win32 错误 {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(job)
}

/// 探测当前进程能否创建并运行受限进程（成本高，结果只算一次）。
#[cfg(windows)]
fn restricted_token_available() -> bool {
    use std::sync::OnceLock;
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let Ok(launcher) = RestrictedProcessLauncher::new() else {
            return false;
        };
        // 试跑一次瞬时进程，验证 CreateProcessAsUserW 特权路径真实可用。
        launcher.run("cmd /c exit 0").is_ok()
    })
}

/// 非 Windows 平台：RestrictedToken 恒不可用。
#[cfg(not(windows))]
fn restricted_token_available() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::PlatformSandbox;

    #[test]
    fn sandbox_available_is_consistent() {
        let backend = RestrictedTokenSandbox;
        // available() 与 wrap() 行为必须一致：不可用则拒绝包装。
        if backend.available() {
            let wrapped = backend.wrap("echo hi").expect("可用时必须能包装");
            assert!(wrapped.starts_with(RESTRICTED_COMMAND_PREFIX));
        } else {
            assert!(backend.wrap("echo hi").is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn launcher_runs_restricted_process() {
        let backend = RestrictedTokenSandbox;
        // 非管理员 / 无令牌特权环境：后端必须诚实声明「不可用」且拒绝包装（fail-closed），
        // 而非静默绕过成默认 shell。此分支是真实断言，杜绝「测试通过但零验证」的假绿。
        if !backend.available() {
            assert!(
                backend.wrap("echo hi").is_none(),
                "不可用后端必须拒绝包装（fail-closed），而非回落默认 shell"
            );
            return;
        }
        let launcher = RestrictedProcessLauncher::new().expect("available() 为真时构造必须成功");
        let code = launcher.run("cmd /c exit 42").expect("受限进程应能启动");
        assert_eq!(code, 42, "受限进程退出码应透传");
    }
}
