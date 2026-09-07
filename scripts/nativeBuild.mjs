// #65 FFI 下沉：构建 omni-napi 原生插件（.node）并复制到 native/。
//
// 外部工具路径统一在下方 CONFIG 中集中管理（见 CONFIG 注释），全部从系统环境变量
// 推导、可用同名环境变量覆盖，代码中不写死任何绝对路径 / 用户名，跨机器可移植。
//
// 定位 cargo：优先 OMNIHARNESS_CARGO 环境变量，其次从 RUSTUP_HOME/主目录推导 GNU 工具链
// 真实二进制（rustup shim 在 git-bash 下 stdout 异常），再退回 PATH 上的 cargo。
// 构建产物：target/ffi/omni_napi.dll → native/omni_napi.node（Node require 直接加载）。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.env;

// ============================================================================
// 外部工具路径配置（集中管理，避免散落硬编码绝对路径 / 用户名 / 版本号）
// 优先级：同名环境变量覆盖 > 系统 env 推导默认 > 最后的平台兜底常量。
// 跨机器 / 跨用户无需改代码，只改环境变量即可。
// ----------------------------------------------------------------------------
// 可覆盖的环境变量：
//   OMNIHARNESS_CARGO      cargo 可执行文件完整路径
//   RUSTUP_HOME            rustup 主目录（推导工具链 bin）
//   GIT_BASH_PATH          bash 可执行文件完整路径（Windows 下为 cargo 重建 MinGW 环境用）
//   GIT_FOR_WINDOWS_ROOT   Git for Windows 安装根目录（其下 mingw64/bin 含 libstdc++-6.dll）
//   MINGW_BIN              含 libstdc++-6.dll 的 MinGW bin 目录
// ============================================================================
const CONFIG = {
  // cargo 可执行文件（为空则由 resolveCargo 从 RUSTUP_HOME/主目录进一步推导）。
  cargo: ENV.OMNIHARNESS_CARGO || '',
  // bash 可执行文件（Windows 下用于重建含 MinGW 运行时的环境）。为空则自动探测。
  gitBash: ENV.GIT_BASH_PATH || '',
  // Git for Windows 安装根目录（其下 mingw64/bin 含 rustc/rust-lld 依赖的 libstdc++-6.dll）。
  // 优先环境变量 GIT_FOR_WINDOWS_ROOT，其次从系统 ProgramFiles 推导；二者皆缺时退化为相对候选。
  gitRoot: ENV.GIT_FOR_WINDOWS_ROOT || (ENV.ProgramFiles ? join(ENV.ProgramFiles, 'Git') : 'Git'),
  // 含 libstdc++-6.dll 的 MinGW bin 目录（rustc/rust-lld 运行时依赖）。为空则自动探测。
  mingwBin: ENV.MINGW_BIN || '',
  // rustup 主目录（推导工具链 bin 路径）。
  rustupHome: ENV.RUSTUP_HOME || join(homedir(), '.rustup'),
  // bash 内强制前置的 PATH 前缀（msys 虚拟路径 + 工具链 bin 由代码动态补入）。
  bashPathPrefixes: ['/mingw64/bin', '/usr/bin'],
};

/** 将 Windows 路径转为 POSIX 形式（盘符前缀改为 /小写盘符，反斜杠转正斜杠），供 bash -c 内使用。 */
function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
}

/** 解析可用的 cargo 可执行文件路径。 */
function resolveCargo() {
  if (CONFIG.cargo) return CONFIG.cargo;
  const candidates = [
    join(CONFIG.rustupHome, 'toolchains', 'stable-x86_64-pc-windows-gnu', 'bin', 'cargo.exe'),
    join(homedir(), '.cargo', 'bin', 'cargo.exe'),
    'cargo',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 尝试下一个
    }
  }
  throw new Error('未找到 cargo：请设置 OMNIHARNESS_CARGO 或安装 Rust 工具链');
}

/** 列出 PortableGit 各版本下的 bash 候选（版本号不写死，通配 versions/*）。 */
function portableGitBashes() {
  const base = join(homedir(), '.workbuddy', 'binaries', 'PortableGit', 'versions');
  const out = [];
  try {
    for (const ver of readdirSync(base)) {
      out.push(join(base, ver, 'usr', 'bin', 'bash.exe'));
      out.push(join(base, ver, 'bin', 'bash.exe'));
    }
  } catch {
    // 无 PortableGit 安装，跳过
  }
  return out;
}

/** 解析可用的 bash（用于 Windows 下为 cargo 重建正确的 MinGW 环境）。 */
function resolveBash() {
  if (process.platform !== 'win32') return undefined;
  if (CONFIG.gitBash) return CONFIG.gitBash;
  const candidates = [
    join(CONFIG.gitRoot, 'usr', 'bin', 'bash.exe'),
    join(CONFIG.gitRoot, 'bin', 'bash.exe'),
    join(ENV['ProgramFiles(x86)'] || '', 'Git', 'usr', 'bin', 'bash.exe'),
    ...portableGitBashes(),
    'bash',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 尝试下一个
    }
  }
  return undefined;
}

// 对含非安全字符（空格/中文/括号等）的 shell 参数加双引号，避免 bash -c 解析出错。
function shellQuote(s) {
  if (/[^\w./:\\-]/.test(s)) return `"${s}"`;
  return s;
}

const cargo = resolveCargo();
console.log(`[native:build] cargo = ${cargo}`);
const bash = resolveBash();

// rustc/rust-lld 是 C++ 实现，依赖 libstdc++-6.dll 等 MinGW 运行时。这些 DLL 在 Git for
// Windows 的安装（gitRoot/mingw64/bin）里，而不在 rust 工具链 bin 目录，也不在 npm 派生进程
// 被改写后的 PATH 里。从 Bash 工具启动时 PATH 含该目录，构建正常；从 npm/Node 等非 shell 父
// 进程派生 cargo 时 PATH 丢失它，rustc 启动报 os 193（ERROR_BAD_EXE_FORMAT）。修复：把含
// libstdc++-6.dll 的 MinGW bin 前置到 PATH。
function collectMingwBins() {
  const out = [];
  const seen = new Set();
  const candidates = [];
  if (CONFIG.mingwBin) candidates.push(CONFIG.mingwBin);
  candidates.push(
    join(CONFIG.gitRoot, 'mingw64', 'bin'),
    join(ENV['ProgramFiles(x86)'] || '', 'Git', 'mingw64', 'bin'),
    join(homedir(), 'scoop', 'apps', 'git', 'current', 'mingw64', 'bin'),
  );
  for (const c of candidates) {
    if (c && !seen.has(c) && existsSync(join(c, 'libstdc++-6.dll'))) {
      seen.add(c);
      out.push(c);
    }
  }
  // 兜底：在已有 PATH 里找含 libstdc++-6.dll 的目录。
  for (const p of (ENV.PATH || '').split(';')) {
    if (p && !seen.has(p) && existsSync(join(p, 'libstdc++-6.dll'))) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

const mingwBins = collectMingwBins();
if (mingwBins.length > 0) {
  console.log(`[native:build] 前置 MinGW bin 到 PATH: ${mingwBins.join(' ; ')}`);
} else {
  console.warn(
    '[native:build] 未找到含 libstdc++-6.dll 的 MinGW bin（rustc/rust-lld 可能启动失败）',
  );
}
// buildEnv：宿主进程侧也前置 MinGW bin，双保险（bash profile 重建不可靠时的退路）。
const buildEnv = { ...ENV };
if (mingwBins.length > 0) {
  buildEnv.PATH = mingwBins.join(';') + ';' + (buildEnv.PATH || '');
}

// 构建 omni-napi（ffi profile）。显式关闭 LTO（linker-plugin-lto + rust-lld）：
// 本环境下的 GNU 工具链在 LTO 模式下 rustc 派生 secondary 进程会报 os 193
// （ERROR_BAD_EXE_FORMAT），关闭后产物功能等价、仅放弃链接期优化，且稳定可用。
// 链接器仍走 .cargo/config.toml 里的 rust-lld，故需 MinGW 运行时（libstdc++-6.dll 等）。
const BUILD_ARGS = [
  'build',
  '--profile',
  'ffi',
  '-p',
  'omni-napi',
  '--config',
  'profile.ffi.lto=false',
  '--config',
  'profile.ffi.codegen-units=256',
];

// Windows 下经 Git Bash 中转执行 cargo。
// 原因：从 npm/Node 等非 shell 父进程派生 cargo 时，进程环境被改写，PATH 丢失含
// libstdc++-6.dll 的 MinGW bin 目录，导致 rustc/rust-lld（C++ 实现）启动报 os 193。
// 直接在 bash 命令里强制把已知的 MinGW bin（含 libstdc++-6.dll 的 /mingw64/bin 与工具链
// bin）前置到 PATH，避免依赖 profile 在不同父进程下的不确定行为。buildEnv 也一并前置
// 含 libstdc++-6.dll 的目录，双保险。Linux/macOS 或非 Windows 直接调用 cargo。
function runCargo(args) {
  if (bash) {
    const cargoCmd = [shellQuote(cargo), ...args.map(shellQuote)].join(' ');
    // 工具链 bin 由 cargo 路径动态推导（toPosix(dirname(cargo))），不写死用户名/盘符。
    const toolchainBin = toPosix(dirname(cargo));
    const prefixes = [...CONFIG.bashPathPrefixes, toolchainBin];
    const setup = `export PATH="${prefixes.join(':')}:$PATH"`;
    const cmd = `${setup}; ${cargoCmd}`;
    console.log(`[native:build] 经 bash 中转执行: ${cmd}`);
    execFileSync(bash, ['-lc', cmd], { cwd: root, stdio: 'inherit', env: buildEnv });
    return;
  }
  execFileSync(cargo, args, { cwd: root, stdio: 'inherit', env: buildEnv });
}

runCargo(BUILD_ARGS);

const dll = join(root, 'target', 'ffi', 'omni_napi.dll');
const node = join(root, 'native', 'omni_napi.node');
mkdirSync(dirname(node), { recursive: true });
try {
  copyFileSync(dll, node);
} catch (copyErr) {
  // Windows 下 .node 一旦被进程 require 会加共享锁，直接覆盖会报 EBUSY。
  // 兜底：把旧 .node 改名挪开释放锁，再拷入新产物。
  const old = join(root, 'native', 'omni_napi.old.node');
  try {
    if (existsSync(node)) {
      if (existsSync(old)) {
        try {
          unlinkSync(old);
        } catch {
          /* ignore */
        }
      }
      renameSync(node, old);
    }
    copyFileSync(dll, node);
  } catch (e2) {
    throw new Error(
      `[native:build] 拷贝 ${dll} -> ${node} 失败（可能被其他进程锁定）：` +
        (e2 instanceof Error ? e2.message : String(e2)),
    );
  }
}
console.log(`[native:build] ${dll} -> ${node}`);
