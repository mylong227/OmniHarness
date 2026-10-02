#!/usr/bin/env node
// LSP 候选源 offline probe —— 在接生产前先验证「真实子进程 LSP 往返」能否产出有效引用/定义位置。
//
// 审计 §5 项 #6 明确要求：「先做 offline probe，勿直接上生产」。本脚本即该探针：
//   - 用真实 LspProcessAdapter 拉起语言服务器子进程（typescript-language-server 等）；
//   - 对若干锚点符号查询跑 LspCandidateSource.candidatesFor（BM25 seed → references/definition 扩展）；
//   - 记录每查询延迟、命中文件数、失败率，落盘 evals/probe-lsp-candidates.report.json。
//
// 何时 SKIP（不视为失败，而是「尚未具备生产前提」）：
//   - 未配置 / 未安装 LSP 服务器（env OMNI_PROBE_LSP_CMD 缺省且 PATH 中无 typescript-language-server）。
//   - 在此类沙箱里默认不联网 npx，避免无谓下载挂起；需要时用 OMNI_PROBE_LSP_CMD 显式指定服务器。
//
// 用法：
//   node evals/probe-lsp-candidates.mjs
//   OMNI_PROBE_LSP_CMD="npx --yes typescript-language-server --stdio" node evals/probe-lsp-candidates.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const importDist = (...segments) => import(pathToFileURL(join(DIST, ...segments)).href);

const REPORT = join(ROOT, 'evals', 'probe-lsp-candidates.report.json');

/** 解析服务器命令：env OMNI_PROBE_LSP_CMD 优先，否则默认 typescript-language-server。 */
const rawCmd = process.env.OMNI_PROBE_LSP_CMD ?? 'typescript-language-server --stdio';
const [serverCommand, ...serverArgs] = rawCmd.split(/\s+/);

/** 锚点查询（真实存在的符号名，便于人工复核命中是否合理）。 */
const ANCHOR_QUERIES = [
  'RepoMapContextEngine',
  'LspCandidateSource',
  'DangerousCommands',
  'HybridRanker',
  'Bm25Index',
];

/** 检测服务器是否可达（PATH 中能否解析命令）。 */
function serverReachable(cmd) {
  try {
    execSync(`command -v ${JSON.stringify(cmd)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!serverReachable(serverCommand)) {
    const report = {
      status: 'SKIP',
      reason: `未检测到 LSP 服务器命令「${serverCommand}」；本沙箱不默认联网 npx。`,
      hint: '配置可用语言服务器后重跑，例如：OMNI_PROBE_LSP_CMD="npx --yes typescript-language-server --stdio" node evals/probe-lsp-candidates.mjs',
      serverCommand,
      serverArgs,
      anchorQueries: ANCHOR_QUERIES,
      perQuery: [],
      at: new Date().toISOString(),
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`[probe-lsp-candidates] SKIP: ${report.reason}`);
    return;
  }

  const { ContextEngine } = await importDist('context', 'contextEngine.js');
  const { LspCandidateSource } = await importDist('context', 'lspCandidateSource.js');
  const { LspProcessAdapter } = await importDist('adapters', 'lsp', 'lspProcessAdapter.js');

  const src = join(ROOT, 'src');
  const corpus = ContextEngine.indexCorpus(src, { morph: true, light: true });
  const rootUri = pathToFileURL(ROOT).href;
  const adapter = new LspProcessAdapter(
    { serverCommand, serverArgs, rootUri },
    { diagnosticsTimeoutMs: 5000 },
  );
  const src2 = new LspCandidateSource();

  const perQuery = [];
  let failures = 0;
  let healthError = undefined;
  try {
    // 健康探针：先发一次 references 确认服务器能 initialize 并应答（失败即整体不可达）。
    const probeFile = join(src, 'context', 'lspCandidateSource.ts');
    await adapter.references(probeFile, 1, 1);

    for (const q of ANCHOR_QUERIES) {
      const t0 = Date.now();
      try {
        const ids = await src2.candidatesFor(q, adapter, corpus, {
          seedLimit: 8,
          perCallTimeoutMs: 2000,
        });
        perQuery.push({
          query: q,
          ok: true,
          elapsedMs: Date.now() - t0,
          fileCandidates: ids.fileIds.length,
          symCandidates: ids.symIds.length,
        });
      } catch (error) {
        failures += 1;
        perQuery.push({
          query: q,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - t0,
        });
      }
    }
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
  } finally {
    await adapter.shutdown().catch(() => {});
  }

  if (healthError !== undefined) {
    const report = {
      status: 'UNREACHABLE',
      reason: `LSP 服务器 initialize / 首次应答失败：${healthError}`,
      serverCommand,
      serverArgs,
      anchorQueries: ANCHOR_QUERIES,
      perQuery,
      at: new Date().toISOString(),
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`[probe-lsp-candidates] UNREACHABLE: ${report.reason}`);
    return;
  }

  const feasible = perQuery.filter((r) => r.ok && r.fileCandidates > 0).length;
  const report = {
    status: 'DONE',
    serverCommand,
    serverArgs,
    anchorQueries: ANCHOR_QUERIES,
    totals: {
      queries: ANCHOR_QUERIES.length,
      ok: perQuery.filter((r) => r.ok).length,
      failures,
      withHits: feasible,
    },
    perQuery,
    at: new Date().toISOString(),
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(
    `[probe-lsp-candidates] DONE: ${report.totals.ok}/${report.totals.queries} 成功，` +
      `${report.totals.withHits} 个查询产出了 LSP 扩展候选文件。报表：${REPORT}`,
  );
}

main()
  .catch((error) => {
    const report = {
      status: 'ERROR',
      reason: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.error(`[probe-lsp-candidates] ERROR: ${report.reason}`);
  })
  .finally(() => {
    // adapter 在 main 中创建；此处无法引用，由进程退出回收子进程（探针为一次性脚本）。
  });
