// 结构判据：开发回路的地址/端口**字面量只允许出现在唯一事实源里**（2026-10-30，看板 §182）。
//
// 背景：vite proxy 目标、devAll/startAll 起的 serve 端口、就绪探针 URL、测试夹具的回环地址
// 曾各自写死 `8787`/`5173`/`127.0.0.1`——设 OMNI_BACKEND_PORT 只改 vite 一边时开发回路直接断裂。
// 收口后的形态：
//   · dev 工具（vite/devAll/startAll/探针/夹具）→ `scripts/devConfig.mjs`（env 在那里解释一次）；
//   · 后端 serve 默认端口 → `src/cli/serveDefaults.ts`（`--port` 旗标仍最高优先）；
//   · 后端绑定主机 → `ServerAuthGuard.DEFAULT_HOST` + `OMNI_SERVE_HOST`（既有事实源）。
// devConfig 的默认值是 serveDefaults 的**镜像**（node 脚本 import 不了后端 TS）——本判据同时钉住
// 镜像一致性：改默认端口必须两处同改，否则这里红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 消费者名单：这些文件剥掉注释后不得再出现地址/端口字面量（新增消费者请同步登记）。 */
const CONSUMERS = [
  'vite.config.ts',
  'scripts/devAll.mjs',
  'scripts/startAll.mjs',
  'scripts/init-config.mjs',
  'scripts/realUiScenario.mjs',
  'scripts/realRunSmoke.mjs',
  'scripts/lib/launchReadiness.mjs',
  'web/test/browserHarness.ts',
  'web/test/e2e.test.ts',
];

/**
 * 剥掉行注释与 JSDoc 续行（`//`、`*`、`/*` 开头的行）——文档里提到 8787 是合法的，
 * 代码里写死才是回归。
 * @param text 源码全文
 * @returns 去注释后的文本
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

test('消费者文件里不得再有端口/回环主机字面量（一律走 scripts/devConfig.mjs）', () => {
  const offenders: string[] = [];
  for (const rel of CONSUMERS) {
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    for (const m of code.matchAll(/127\.0\.0\.1|:8787|5173/gu)) {
      offenders.push(`${rel} → ${m[0]}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '开发回路地址必须走 scripts/devConfig.mjs（OMNI_BACKEND_PORT/OMNI_UI_PORT/OMNI_DEV_HOST）：\n' +
      offenders.join('\n'),
  );
});

test('devConfig 的默认值与后端 serveDefaults / ServerAuthGuard 保持一致（镜像一致性）', () => {
  const devConfig = readFileSync(join(ROOT, 'scripts', 'devConfig.mjs'), 'utf8');
  const serveDefaults = readFileSync(join(ROOT, 'src', 'cli', 'serveDefaults.ts'), 'utf8');
  const authGuard = readFileSync(
    join(ROOT, 'src', 'server', 'transport', 'serverAuthGuard.ts'),
    'utf8',
  );

  const devBackend = /backendPort:\s*(\d+)/u.exec(devConfig)?.[1];
  const devUi = /uiPort:\s*(\d+)/u.exec(devConfig)?.[1];
  const devHost = /host:\s*'([^']+)'/u.exec(devConfig)?.[1];
  const cliPort = /DEFAULT_SERVE_PORT\s*=\s*(\d+)/u.exec(serveDefaults)?.[1];
  const authHost = /DEFAULT_HOST\s*=\s*'([^']+)'/u.exec(authGuard)?.[1];

  assert.ok(
    devBackend !== undefined && devUi !== undefined && devHost !== undefined,
    'devConfig.mjs 缺少 DEV_DEFAULTS 三元组（解析口径过期？）',
  );
  assert.ok(cliPort !== undefined, 'serveDefaults.ts 缺 DEFAULT_SERVE_PORT（解析口径过期？）');
  assert.ok(authHost !== undefined, 'serverAuthGuard.ts 缺 DEFAULT_HOST（解析口径过期？）');
  assert.strictEqual(
    devBackend,
    cliPort,
    'devConfig.backendPort 与 serveDefaults.DEFAULT_SERVE_PORT 不一致：改默认端口必须两处同改',
  );
  assert.strictEqual(
    devHost,
    authHost,
    'devConfig.host 与 ServerAuthGuard.DEFAULT_HOST 不一致（开发工具连的主机必须是 serve 绑的主机）',
  );
  assert.ok(
    Number(devUi) > 0 && Number(devUi) !== Number(devBackend),
    'uiPort 必须是正数且不得与后端端口相同（同机同端口必冲突）',
  );
});

test('关键消费者确实 import 了 devConfig（防"绕过事实源另起炉灶"）', () => {
  for (const rel of [
    'scripts/devAll.mjs',
    'scripts/startAll.mjs',
    'scripts/lib/launchReadiness.mjs',
  ]) {
    const code = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(
      code,
      /from '\.\.?\/devConfig\.mjs'/u,
      `${rel} 必须 import scripts/devConfig.mjs（地址唯一事实源）`,
    );
  }
  const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  assert.match(
    vite,
    /resolveDevAddress/u,
    'vite.config.ts 必须经 resolveDevAddress 取代理目标与端口',
  );
});
