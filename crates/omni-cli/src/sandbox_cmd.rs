//! `omni sandbox` 子命令（一个子命令一个函数）：
//! - `omni sandbox check`                    探测 RestrictedToken 受限进程能力；
//! - `omni sandbox run --command "<cmd>"`    以受限令牌 + Job Object 启动命令并等待，透传退出码。

use std::process::ExitCode;

use omni_core::{PlatformSandbox, RestrictedTokenSandbox};

/// 子命令分发。
pub fn dispatch(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some("check") => check(),
        Some("run") => run(args),
        _ => {
            eprintln!("用法: omni sandbox check | omni sandbox run --command \"<cmd>\"");
            ExitCode::from(2)
        }
    }
}

/// 探测受限进程能力（输出结构化 JSON）。
fn check() -> ExitCode {
    let backend = RestrictedTokenSandbox;
    println!(
        "{}",
        serde_json::json!({
            "ok": true,
            "name": backend.name(),
            "available": backend.available(),
        })
    );
    ExitCode::SUCCESS
}

/// 以受限令牌 + Job Object 启动命令并等待，透传退出码。
fn run(args: &[String]) -> ExitCode {
    let Some(command) = flag_value(args, "--command") else {
        eprintln!("{{ \"ok\": false, \"error\": \"缺少 --command\" }}");
        return ExitCode::from(1);
    };

    #[cfg(windows)]
    {
        let launcher = match omni_core::RestrictedProcessLauncher::new() {
            Ok(launcher) => launcher,
            Err(e) => {
                eprintln!("{{ \"ok\": false, \"error\": \"{}\" }}", e);
                return ExitCode::from(1);
            }
        };
        match launcher.run(&command) {
            Ok(exit_code) => {
                // 透明转发：受限子进程的 stdout/stderr 已通过继承父句柄到达本进程的管道，
                // 此处不再向 stdout 写状态 JSON——否则会被 shell.run 当成命令输出捕获，
                // 污染工具返回值。成败以退出码透传，由调用方判定。
                std::process::exit(exit_code as i32)
            }
            Err(e) => {
                eprintln!("{{ \"ok\": false, \"error\": \"{}\" }}", e);
                ExitCode::from(1)
            }
        }
    }

    #[cfg(not(windows))]
    {
        eprintln!("{{ \"ok\": false, \"error\": \"RestrictedToken 仅 Windows 可用\" }}");
        ExitCode::from(1)
    }
}

/// 从参数切片取 `--flag value` 的值。
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}
