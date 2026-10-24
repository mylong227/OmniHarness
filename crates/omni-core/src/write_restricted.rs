//! Windows 原生写隔离（WRITE_RESTRICTED 令牌 + 工作区写入 SID + DACL）。
//!
//! 设计要点：
//! - **令牌层**：`CreateRestrictedToken` 带 `WRITE_RESTRICTED`，并注入一个按工作区路径
//!   派生的 restricting SID；该 SID 只参与**写**访问检查，读/执行不受影响。
//! - **授权层**：只把这个 SID 授予工作区（可继承），因此受限子进程能写工作区，
//!   写系统其它位置会被内核拒绝——不依赖命令黑名单或字符串匹配。
//! - **fail-closed**：SID 分配、令牌创建、DACL 写入、Job Object 任一失败都返回错误，
//!   调用方不得回退到无限制启动。
//! - **边界如实**：只限制写；读、网络、进程可见性不受限。工作区 ACE 会常驻（与工作区
//!   绑定的随机 SID，不影响其它账户），需要清理时按同一 SID 撤销。

#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    AllocateAndInitializeSid, CreateRestrictedToken, DuplicateTokenEx, FreeSid,
    SecurityImpersonation, TokenPrimary, ACL, DISABLE_MAX_PRIVILEGE, PSID,
    SECURITY_NULL_SID_AUTHORITY, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_QUERY, WRITE_RESTRICTED,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_DELETE_CHILD, FILE_GENERIC_WRITE};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

#[cfg(windows)]
use crate::restricted_token::{create_job_object, RestrictedProcessLauncher};

/// 写模式：工作区可写 / 只读（连工作区写也拒绝）。
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    /// 工作区可写，工作区外写入被内核拒绝。
    WorkspaceWrite,
    /// 零写入授权：任何路径的写都拒绝。
    ReadOnly,
}

/// 写隔离启动器：持有一个带写限制的 primary 令牌与 Job Object。
#[cfg(windows)]
pub struct WriteRestrictedProcessLauncher {
    inner: RestrictedProcessLauncher,
}

#[cfg(windows)]
impl WriteRestrictedProcessLauncher {
    /// 为指定工作区创建工作隔离启动器（失败即 fail-closed）。
    /// @param workspace 唯一可写目录（`ReadOnly` 时忽略）。
    /// @param mode 写模式。
    /// @returns 启动器；任一系统调用失败时返回可读错误。
    pub fn new(workspace: &Path, mode: WriteMode) -> Result<Self, String> {
        let sid = allocate_workspace_sid(workspace, mode)?;
        let grant = if mode == WriteMode::WorkspaceWrite {
            grant_write_access(workspace, sid)
        } else {
            Ok(())
        };
        if let Err(error) = grant {
            unsafe { FreeSid(sid) };
            return Err(error);
        }
        let token = create_write_restricted_token(sid);
        unsafe { FreeSid(sid) };
        let token = token?;
        let job = create_job_object()?;
        Ok(Self {
            inner: RestrictedProcessLauncher::from_parts(token, job),
        })
    }

    /// 运行命令并捕获输出（原始字节 + 退出码）。
    /// @param command 命令文本（经 `cmd /C` 执行）。
    /// @param current_dir 子进程工作目录。
    /// @returns 原始输出字节与退出码。
    pub fn run_capture(
        &self,
        command: &str,
        current_dir: Option<&Path>,
    ) -> Result<(Vec<u8>, u32), String> {
        self.inner.run_capture(command, current_dir)
    }

    /// 运行命令并把捕获输出写到 stdout（CLI 场景），返回退出码。
    /// @param command 命令文本（经 `cmd /C` 执行）。
    /// @param current_dir 子进程工作目录。
    /// @returns 子进程退出码。
    pub fn run(&self, command: &str, current_dir: &Path) -> Result<u32, String> {
        use std::io::Write;
        let (out, code) = self.inner.run_capture(command, Some(current_dir))?;
        let _ = std::io::stdout().write_all(&out);
        Ok(code)
    }
}

/// 探测当前进程能否真正建立写隔离（缓存一次）。
/// @returns 可用返回 true；任何一步失败返回 false。
#[cfg(windows)]
pub fn write_restricted_available() -> bool {
    use std::sync::OnceLock;
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir();
        let dir = base.join(format!("omni-wr-probe-{}-{}", std::process::id(), stamp));
        let outside = base.join(format!(
            "omni-wr-outside-{}-{}.txt",
            std::process::id(),
            stamp
        ));
        if std::fs::create_dir_all(&dir).is_err() {
            return false;
        }
        let ok: Result<bool, String> = (|| {
            let launcher = WriteRestrictedProcessLauncher::new(&dir, WriteMode::WorkspaceWrite)?;
            let command = format!(
                "echo inside> inside.txt & echo outside> \"{}\"",
                outside.display()
            );
            let (_out, code) = launcher.run_capture(&command, Some(&dir))?;
            if code == 0 {
                return Ok(false);
            }
            Ok(dir.join("inside.txt").exists() && !outside.exists())
        })();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
        ok.unwrap_or(false)
    })
}

#[cfg(not(windows))]
/// 非 Windows：写隔离恒不可用。
pub fn write_restricted_available() -> bool {
    false
}

/// 按工作区路径 + 模式派生一个稳定的 restricting SID（S-1-0-x-y）。
#[cfg(windows)]
fn allocate_workspace_sid(workspace: &Path, mode: WriteMode) -> Result<PSID, String> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let normalized = workspace.to_string_lossy().to_lowercase();
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    if mode == WriteMode::ReadOnly {
        hash ^= 0x9e37_79b9_7f4a_7c15;
    }
    let high = (hash >> 32) as u32;
    let low = hash as u32;
    let mut sid: PSID = std::ptr::null_mut();
    let authority = SECURITY_NULL_SID_AUTHORITY;
    let ok =
        unsafe { AllocateAndInitializeSid(&authority, 2, high, low, 0, 0, 0, 0, 0, 0, &mut sid) };
    if ok == 0 || sid.is_null() {
        return Err(format!(
            "AllocateAndInitializeSid 失败, win32 错误 {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(sid)
}

/// 把写入 SID 授予工作区（可继承到子容器/对象）。
#[cfg(windows)]
fn grant_write_access(workspace: &Path, sid: PSID) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = workspace.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let rc = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut old_dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if rc != 0 {
        return Err(format!("GetNamedSecurityInfoW 失败, win32 错误 {rc}"));
    }

    let mut entry: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
    entry.grfAccessPermissions = FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD;
    entry.grfAccessMode = GRANT_ACCESS;
    entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    entry.Trustee = TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: 0,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid as *mut u16,
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let rc = unsafe { SetEntriesInAclW(1, &entry, old_dacl, &mut new_dacl) };
    if rc != 0 {
        unsafe { LocalFree(descriptor as HLOCAL) };
        return Err(format!("SetEntriesInAclW 失败, win32 错误 {rc}"));
    }
    let rc = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        LocalFree(new_dacl as HLOCAL);
        LocalFree(descriptor as HLOCAL);
    }
    if rc != 0 {
        return Err(format!("SetNamedSecurityInfoW 失败, win32 错误 {rc}"));
    }
    Ok(())
}

/// 创建带 `WRITE_RESTRICTED` 的 primary 令牌。
#[cfg(windows)]
fn create_write_restricted_token(sid: PSID) -> Result<HANDLE, String> {
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

    let restrict = SID_AND_ATTRIBUTES {
        Sid: sid,
        Attributes: 0,
    };
    let mut restricted: HANDLE = INVALID_HANDLE_VALUE;
    let ok = unsafe {
        CreateRestrictedToken(
            process_token,
            DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            1,
            &restrict,
            &mut restricted,
        )
    };
    unsafe { CloseHandle(process_token) };
    if ok == 0 {
        return Err(format!(
            "CreateRestrictedToken(WRITE_RESTRICTED) 失败, win32 错误 {}",
            unsafe { GetLastError() }
        ));
    }

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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 建唯一临时目录。
    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("omni-wr-{}-{}-{}", tag, std::process::id(), stamp));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn workspace_write_is_isolated() {
        if !write_restricted_available() {
            eprintln!("skip: 当前环境不能创建写隔离令牌");
            return;
        }
        let root = temp_dir("inside");
        let outside = std::env::temp_dir().join(format!(
            "omni-wr-outside-{}-{}.txt",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let launcher = WriteRestrictedProcessLauncher::new(&root, WriteMode::WorkspaceWrite)
            .expect("写隔离启动器应可构造");
        let command = format!("echo in> inside.txt & echo out> \"{}\"", outside.display());
        let (_out, code) = launcher
            .run_capture(&command, Some(&root))
            .expect("受限命令应能启动");
        assert_ne!(code, 0, "越界写入应让命令非零退出");
        assert!(root.join("inside.txt").exists(), "工作区内写入必须成功");
        assert!(!outside.exists(), "工作区外写入必须被内核拒绝");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn read_only_denies_workspace_write() {
        if !write_restricted_available() {
            eprintln!("skip: 当前环境不能创建写隔离令牌");
            return;
        }
        let root = temp_dir("readonly");
        let launcher = WriteRestrictedProcessLauncher::new(&root, WriteMode::ReadOnly)
            .expect("只读启动器应可构造");
        let (_out, code) = launcher
            .run_capture("echo no> blocked.txt", Some(&root))
            .expect("受限命令应能启动");
        assert_ne!(code, 0, "只读模式下工作区写入也必须失败");
        assert!(!root.join("blocked.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
