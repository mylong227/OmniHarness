#!/usr/bin/env node
// U6 A2A 回环实测（OmniHarness）。
//
// 目的：看板 U6 验收要求「回环延迟/完成率实测」。本脚本在本地起一个真实
//       HttpA2aServerTransport（node:http 监听 POST /a2a）+ A2aClient 经真实
//       HTTP 回环，执行「能力声明 → N 次任务委托 → 结果回传」，测逐任务
//       端到端延迟分布与完成率，产出 evals/a2a-loopback.report.json。
//
// 诚实口径：本脚本测的是传输层 + 协议层的回环延迟（不含 LLM 推理）；
//       任务处理器为确定性本地回显（无 mock 网络、无伪造延迟数据）。
//
// fail-closed：完成率 < --min-completion 或完整性校验不过 → exit 1。
//
// 用法：
//   node evals/a2a-loopback.mjs                    # 默认 30 任务，串行
//   node evals/a2a-loopback.mjs --n 50             # 50 次委托
//   node evals/a2a-loopback.mjs --concurrency 5    # 并发 5 跑批
//   node evals/a2a-loopback.mjs --min-completion 1 # 完成率门禁（默认 1）

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');

/** 跨平台安全动态导入：Windows 下必须转 file:// URL。 */
function importDist(...segments) {
  return import(pathToFileURL(join(DIST, ...segments)).href);
}

const { A2aClient, A2aServer, HttpA2aTransport, HttpA2aServerTransport } = await importDist(
  'a2a',
  'index.js',
);

/** 解析 --flag 或返回 undefined。 */
function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 解析数字 flag（含缺省）。 */
function numFlag(name, dflt) {
  const v = flag(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 抓一个空闲 TCP 端口（listen(0) 后取实际端口再释放）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 确定性本地任务处理器：模拟子 agent 完成一次委托（无 LLM、无外部依赖）。 */
function makeHandler() {
  let handled = 0;
  return {
    get handledCount() {
      return handled;
    },
    async handle(request) {
      const t0 = performance.now();
      handled += 1;
      // 确定性小负载：0..1000 求和 = 500500（客户端据此做完整性校验）。
      let sum = 0;
      for (let i = 0; i <= 1000; i++) sum += i;
      return {
        ok: true,
        output: `echo:${request.taskId}:${sum}`,
        steps: 1,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}

/** 延迟统计。 */
function latencyStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    min: sorted[0],
    avg: Math.round(avg * 100) / 100,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
  };
}

/** 委托一个任务并计时。 */
async function delegateOnce(client, index) {
  const taskId = `bench-${index}`;
  const t0 = performance.now();
  try {
    const result = await client.delegateTask({
      taskId,
      task: `echo task ${index}`,
      requesterId: 'omniharness-bench-client',
    });
    const latencyMs = Math.round(performance.now() - t0);
    const integrityOk = result.ok === true && result.output === `echo:${taskId}:500500`;
    return { taskId, ok: result.ok === true, integrityOk, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    return {
      taskId,
      ok: false,
      integrityOk: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const n = Math.max(1, numFlag('--n', 30));
  const concurrency = Math.max(1, numFlag('--concurrency', 1));
  const minCompletion = numFlag('--min-completion', 1);
  const outPath = flag('--out') ?? join(ROOT, 'evals', 'a2a-loopback.report.json');

  const port = await freePort();
  const serverTransport = new HttpA2aServerTransport();
  const listenPort = await serverTransport.listen(port);
  const handler = makeHandler();
  const server = new A2aServer(serverTransport);
  server.setTaskHandler(handler);

  const clientTransport = new HttpA2aTransport(`http://127.0.0.1:${listenPort}/a2a`);
  await clientTransport.validate(); // SSRF 显式校验（建立连接前，配置错误显性暴露）
  const client = new A2aClient(clientTransport);

  let declaration = null;
  let declarationLatencyMs = null;
  let fatal = null;
  try {
    // 1) 能力声明（经真实 HTTP 回环）。
    const t0 = performance.now();
    await client.declareCapabilities('omniharness-bench-client', [
      { name: 'echo-task', description: 'U6 回环实测回显任务' },
    ]);
    declarationLatencyMs = Math.round(performance.now() - t0);
    declaration = server.getDeclaration('omniharness-bench-client');
    if (declaration === undefined) {
      throw new Error('能力声明未在服务端登记');
    }
    console.log(
      `[a2a-loopback] 能力声明 OK（${declarationLatencyMs}ms），capabilities=${declaration.capabilities.length}`,
    );

    // 2) N 次任务委托（串行或并发跑批）。
    const results = [];
    if (concurrency === 1) {
      for (let i = 0; i < n; i++) {
        results.push(await delegateOnce(client, i));
      }
    } else {
      for (let base = 0; base < n; base += concurrency) {
        const batch = [];
        for (let i = base; i < Math.min(base + concurrency, n); i++) {
          batch.push(delegateOnce(client, i));
        }
        results.push(...(await Promise.all(batch)));
      }
    }

    // 3) 汇总。
    const completed = results.filter((r) => r.ok).length;
    const integrityOkCount = results.filter((r) => r.integrityOk).length;
    const completionRate = completed / n;
    const integrityRate = integrityOkCount / n;
    const okLatencies = results.filter((r) => r.ok).map((r) => r.latencyMs);
    const latency = okLatencies.length > 0 ? latencyStats(okLatencies) : null;
    const pass = completionRate >= minCompletion && integrityRate === 1;

    const report = {
      timestamp: new Date().toISOString(),
      scope: 'U6 A2A 回环实测（传输层+协议层，不含 LLM）',
      endpoint: `http://127.0.0.1:${listenPort}/a2a`,
      taskCount: n,
      concurrency,
      handlerHandled: handler.handledCount,
      completed,
      completionRate,
      integrityOkCount,
      integrityRate,
      declarationLatencyMs,
      latencyMs: latency,
      perTask: results,
      gate: { minCompletion, pass },
    };
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('[a2a-loopback] ===== U6 A2A 回环实测结果 =====');
    console.log(
      `任务数: ${n}（并发 ${concurrency}）  完成: ${completed}  完成率: ${(completionRate * 100).toFixed(1)}%`,
    );
    console.log(`完整性校验: ${integrityOkCount}/${n}（回显 = 确定性 500500）`);
    if (latency !== null) {
      console.log(
        `回环延迟 ms: avg=${latency.avg}  p50=${latency.p50}  p95=${latency.p95}  max=${latency.max}  min=${latency.min}`,
      );
    }
    console.log(`报告: ${outPath}`);
    if (!pass) {
      console.error(
        `[a2a-loopback] FAIL：完成率 ${(completionRate * 100).toFixed(1)}% < 门禁 ${minCompletion} 或完整性不足`,
      );
      process.exitCode = 1;
    } else {
      console.log('[a2a-loopback] PASS');
    }
  } catch (err) {
    fatal = err instanceof Error ? err.message : String(err);
    console.error(`[a2a-loopback] FATAL: ${fatal}`);
    process.exitCode = 1;
  } finally {
    client.close();
    serverTransport.close();
  }
}

await main();
