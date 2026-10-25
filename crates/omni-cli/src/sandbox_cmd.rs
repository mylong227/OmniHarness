//! `omni sandbox` 子命令（一个子命令一个函数）：
//! - `omni sandbox check`                    探测受限进程与原生写隔离能力；
//! - `omni sandbox run --command "<cmd>"`    以受限令牌 + Job Object 启动命令并等待，透传退出码；
//!   追加 `--workspace <dir>` 时启用原生写隔离（该目录是唯一可写根），`--read-only` 则零写授权。

use std::process::ExitCode;

use omni_core::{PlatformSandbox, RestrictedTokenSandbox};

/// 子命令分发。
pub fn dispatch(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        Some("check") => check(),
        Some("run") => run(args),
        _ => {
            eprintln!(
                "用法: omni sandbox check | omni sandbox run --command \"<cmd>\" [--command-file <path>] [--workspace <dir>] [--read-only]"
            );
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
            "writeRestricted": omni_core::write_restricted_available(),
        })
    );
    ExitCode::SUCCESS
}

/// 以受限令牌 + Job Object 启动命令并等待，透传退出码。
fn run(args: &[String]) -> ExitCode {
    // 参数提取放进 Windows 分支（仅该分支消费；无门控提取会在 Linux 上触发
    // unused variable，clippy -D warnings 阻断——ubuntu 首跑实证）。
    #[cfg(windows)]
    {
        let command = match flag_value(args, "--command") {
            Some(command) => command,
            None => match flag_value(args, "--command-file") {
                Some(path) => match std::fs::read_to_string(&path) {
                    Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
                    Err(error) => {
                        eprintln!(
                            "{{ \"ok\": false, \"error\": \"读取 --command-file 失败: {}\" }}",
                            error
                        );
                        return ExitCode::from(1);
                    }
                },
                None => {
                    eprintln!(
                        "{{ \"ok\": false, \"error\": \"缺少 --command 或 --command-file\" }}"
                    );
                    return ExitCode::from(1);
                }
            },
        };
        // 给了 --workspace 就启用原生写隔离；否则保留旧的特权削减路径。
        if let Some(workspace) = flag_value(args, "--workspace") {
            let mode = if args.iter().any(|arg| arg == "--read-only") {
                omni_core::WriteMode::ReadOnly
            } else {
                omni_core::WriteMode::WorkspaceWrite
            };
            let launcher = match omni_core::WriteRestrictedProcessLauncher::new(
                std::path::Path::new(&workspace),
                mode,
            ) {
                Ok(launcher) => launcher,
                Err(error) => {
                    eprintln!("{{ \"ok\": false, \"error\": \"{}\" }}", error);
                    return ExitCode::from(1);
                }
            };
            return match launcher.run(&command, std::path::Path::new(&workspace)) {
                Ok(code) => std::process::exit(code as i32),
                Err(error) => {
                    eprintln!("{{ \"ok\": false, \"error\": \"{}\" }}", error);
                    ExitCode::from(1)
                }
            };
        }
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
        let _ = args;
        eprintln!("{{ \"ok\": false, \"error\": \"RestrictedToken 仅 Windows 可用\" }}");
        ExitCode::from(1)
    }
}

/// 从参数切片取 `--flag value` 的值。
/// 仅 Windows 分支消费（平台门控同 run；Linux 上无其他调用点，dead_code 会被 -D warnings 阻断）。
#[cfg(windows)]
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}
