/**
 * 硬编码清单判据（2026-10-30，goal round 9）。
 *
 * ## 它盯什么
 *
 * P1–P9 把「端点/地址、超时/上限、保留策略」逐类迁进了 `defaults/*.json` + `omniharness.json`，
 * 每一类都有自己的**具体字面量守卫**（`runtimeLimits.test.ts` / `endpointDefaults.test.ts`）。
 * 那些守卫钉的是「旧值不得回来」；本判据钉的是**更一般的形式**：
 * 已迁移的消费者里**不得再出现任何** ≥1000 的运维数值字面量（不管是不是旧值），
 * 以及 `LimitEnv.int('OMNI_X', <数字>)` 这种「env 名 + 内联默认值」的老写法。
 *
 * ## 为什么用扫描器而不是再抄一份正则
 *
 * `scripts/auditHardcodes.mjs` 是**报告型**清单工具（`npm run audit:hardcodes`），
 * 本判据直接调它的 `collectHardcodes`：判据与报告共用同一套分类规则，
 * 不会出现「报告说没有、判据说有」的两套口径。
 *
 * ## 豁免
 *
 * 行内注 `hardcode-exempt` 可豁免（协议常量等），但本判据额外要求：豁免行必须真的在
 * 已迁移文件之外的合理位置——所以这里断言的是「已迁移文件里 0 条」，
 * 豁免只服务于审计报告的可读性（当前 2 条：SSE retry 协议值、PowerShell 清理探针本地超时）。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';

/** 仓库根（判据与清单脚本都按 cwd 解析）。 */
const ROOT = process.cwd();

/** 清单脚本的导出形状。 */
interface AuditModule {
  readonly collectHardcodes: (
    root: string,
    files: readonly string[],
  ) => {
    hits: ReadonlyArray<{ file: string; line: number; category: string; text: string }>;
    scanned: number;
  };
  readonly summarize: (hits: ReadonlyArray<{ category: string }>) => Record<string, number>;
}

/**
 * 载入清单脚本（ESM，非 tsc 编译产物 ⇒ 按 cwd 绝对路径动态 import）。
 * @returns 模块导出。
 */
async function loadAudit(): Promise<AuditModule> {
  const url = pathToFileURL(join(ROOT, 'scripts', 'auditHardcodes.mjs')).href;
  return (await import(url)) as AuditModule;
}

/**
 * 递归收集 src 下的 .ts（与清单脚本同口径）。
 * @param dir 起始目录。
 * @returns 文件绝对路径。
 */
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSrc(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 已迁移的消费者：这些文件里出现运维数值字面量 = 迁移被回滚。 */
const MIGRATED = [
  'server/transport/httpServer.ts',
  'server/transport/previewServer.ts',
  'a2a/a2aClient.ts',
  'a2a/a2aPushNotifications.ts',
  'a2a/a2aTaskStore.ts',
  'a2a/a2aTaskPager.ts',
  'a2a/httpA2aTransport.ts',
  'adapters/tool/web/webFetchTool.ts',
  'adapters/browser/browserSession.ts',
  'adapters/browser/playwrightBrowserSession.ts',
  'adapters/browser/cdpClient.ts',
  'adapters/browser/chromeProcess.ts',
  'adapters/browser/browserAvailability.ts',
  'adapters/tool/browser/browserScreenshotTool.ts',
  'adapters/tool/browser/browserActTool.ts',
  'adapters/lsp/lspJsonRpcConnection.ts',
  'adapters/lsp/lspProcessAdapter.ts',
  'util/sessionGc.ts',
  'util/tmpSweep.ts',
  'util/maintenanceRunner.ts',
  'config/configToolRegistry.ts',
  'config/mediaStackAssembler.ts',
];

test('① 分类器正对照：超时字面量 / 地址 / 豁免行各按规则命中', async () => {
  const { collectHardcodes } = await loadAudit();
  const root = mkdtempSync(join(tmpdir(), 'omni-hardcode-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'sample.ts'),
      [
        '// 文档里的 https://example.com 不算',
        'const timeoutMs = 30_000;',
        "const endpoint = 'https://api.example.com/v1';",
        "const retry = 'retry: 1000'; // hardcode-exempt",
        '',
      ].join('\n'),
      'utf8',
    );
    const { hits } = collectHardcodes(root, [join(root, 'src', 'sample.ts')]);
    const categories = hits.map((h) => h.category).sort();
    assert.deepStrictEqual(categories, ['address', 'ops-literal'], '豁免行与注释行不得计入');
    assert.strictEqual(hits.length, 2, '正对照必须真的抓到两条（否则分类器是空转）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('② 已迁移的消费者里不得再出现运维数值字面量（不管是不是旧值）', async () => {
  const { collectHardcodes } = await loadAudit();
  const files = walkSrc(join(ROOT, 'src'));
  const { hits } = collectHardcodes(ROOT, files);
  const offenders = hits
    .filter((h) => h.category === 'ops-literal')
    .filter((h) => MIGRATED.some((m) => h.file.endsWith(m)))
    .map((h) => `${h.file}:${String(h.line)} ${h.text}`);
  assert.deepStrictEqual(
    offenders,
    [],
    '这些文件的值必须来自 defaults/limits.json（或明确的 hardcode-exempt 豁免）：\n' +
      offenders.join('\n'),
  );
});

test('③ env 旋钮的默认值必须来自数据，不得再写 LimitEnv.int(名字, 数字)', async () => {
  const { collectHardcodes } = await loadAudit();
  const files = walkSrc(join(ROOT, 'src'));
  const { hits } = collectHardcodes(ROOT, files);
  const offenders = hits
    .filter((h) => h.category === 'limit-env')
    .map((h) => `${h.file}:${String(h.line)} ${h.text}`);
  assert.deepStrictEqual(
    offenders,
    [],
    '新增 env 旋钮请用 LimitEnv.int(名字, runtimeLimits.defaults().<段>.<键>)：\n' +
      offenders.join('\n'),
  );
});
