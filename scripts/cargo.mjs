#!/usr/bin/env node
// 跨平台 cargo 启动代理：本机 `~/.cargo/bin/cargo.exe` 可能是 0 字节垫片（实测），
// 直接 `cargo ...` 会以「不是有效的 Win32 应用程序」失败；这里按
// OMNIHARNESS_CARGO → rustup toolchain → ~/.cargo/bin → PATH 的顺序找**真实可执行**，
// 并把 toolchain/bin 前置到 PATH，保证 rustc 也能被解析到。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** 候选 cargo 路径。 */
function candidates() {
  const out = [];
  if (process.env['OMNIHARNESS_CARGO']) out.push(process.env['OMNIHARNESS_CARGO']);
  const rustupHome = process.env['RUSTUP_HOME'] ?? join(homedir(), '.rustup');
  const toolchains = join(rustupHome, 'toolchains');
  if (existsSync(toolchains)) {
    for (const name of ['stable-x86_64-pc-windows-gnu', 'stable-x86_64-pc-windows-msvc', 'stable']) {
      out.push(join(toolchains, name, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
    }
  }
  out.push(join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  out.push('cargo');
  return out;
}

/** 选第一个 `--version` 能跑通的 cargo。 */
function resolveCargo() {
  for (const candidate of candidates()) {
    if (candidate !== 'cargo' && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 10_000 });
      return candidate;
    } catch {
      // 0 字节垫片 / 不可执行：继续找下一个。
    }
  }
  throw new Error('未找到可用的 cargo：请设置 OMNIHARNESS_CARGO 或安装 Rust 工具链');
}

const cargo = resolveCargo();
const env = { ...process.env };
// Windows 的 PATH 可能以 `Path` 键出现（npm/宿主注入）；两种键都取，避免把系统 PATH 覆盖掉。
const basePath = env['PATH'] ?? env['Path'] ?? '';
env['PATH'] = `${dirname(cargo)}${delimiter}${basePath}`;
try {
  execFileSync(cargo, process.argv.slice(2), { stdio: 'inherit', env });
} catch (error) {
  process.exit(typeof error?.status === 'number' ? error.status : 1);
}
