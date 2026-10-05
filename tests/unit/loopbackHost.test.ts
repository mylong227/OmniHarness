/**
 * 回环地址判据：**对外输出的 URL 不得写 `localhost`**。
 *
 * ## 为什么这是一条判据（而不是风格偏好）
 *
 * 服务端默认只绑回环 IPv4（`ServerAuthGuard.DEFAULT_HOST = 127.0.0.1`，见其文件头"默认只绑回环"）。
 * 而 Windows 上 `localhost` 常**先解析到 `::1`**（IPv6）⇒ 拿到该 URL 的用户/脚本会**间歇性拒连**：
 * 同一命令有时能连、有时连不上，与负载、DNS 缓存、解析顺序相关——这正是最难查的一类缺陷。
 *
 * 本会话实测复现过：满载下 `httpServer` 的静态页判据偶发失败（`localhost` ⇒ `::1`）。
 * 故把它固化成判据：**生产代码输出的 URL 必须用实际绑定地址**（或与服务端同一常量），
 * 判据自身也用 `127.0.0.1` 连接（确定性，而不是靠重试掩盖）。
 *
 * ## 允许出现的场合
 *
 * 只在**用户自备端点**的口径里允许（如本地 LLM 服务 `http://localhost:11434`——那是**别人**的服务，
 * 我们不去规定它绑哪个地址）；本判据只拦「本仓自己启动的服务 + 自己拼的 URL」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 扫描根（本仓生产源码）。 */
const ROOTS = ['src/cli', 'src/server'];

/** 允许出现 `localhost` 的文件（用户自备端点的口径：我们不去规定别人的服务绑哪个地址）。 */
const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // 本地模型服务端点（Ollama 等）是**用户自备**的地址，不属本仓服务。
  'src/cli/cliModelCmds.ts',
]);

/**
 * 递归收集目录下的 .ts 文件。
 * @param dir 目录
 * @param out 收集器
 * @returns 文件路径（相对仓库根）
 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, out);
      continue;
    }
    if (name.endsWith('.ts')) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

test('回环地址：本仓服务对外输出的 URL 不得写 localhost（Windows 可能解析到 ::1 而服务端只绑 IPv4）', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of collect(root)) {
      if (ALLOWED_FILES.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      // 只拦"拼给自己服务的 URL"形态：`http://localhost` 出现在源码里即命中。
      for (const line of text.split('\n')) {
        if (!/http:\/\/localhost/.test(line)) continue;
        // 注释里讨论这件事（含本判据里的说明）不算违规。
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `以下位置对外输出了 localhost（应改用 ServerAuthGuard.DEFAULT_HOST / 实际绑定地址）：\n${offenders.join('\n')}`,
  );
});

test('回环地址：服务端默认绑定常量存在且为回环 IPv4（判据依赖它，不能悄悄改）', async () => {
  const { ServerAuthGuard } = await import('../../src/server/transport/serverAuthGuard.js');
  assert.strictEqual(
    ServerAuthGuard.DEFAULT_HOST,
    '127.0.0.1',
    '默认绑定地址必须是回环 IPv4：改成域名会让"只绑回环"的保证依赖 DNS 解析',
  );
});
