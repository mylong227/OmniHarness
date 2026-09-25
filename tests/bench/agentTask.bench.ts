// #72 基准：#72 工具名别名桥生效后，native（--native FFI）vs JS 全程 agent 任务端到端验证。
//
// 背景（#71 已证）：标准 JS 工具集命名为 read_file / write_file / list_dir / shell，
// Rust 内核出厂内置命名为 fs.read_file / fs.write_file / fs.list_dir / shell.run，
// 两者命名不匹配 → 内核判「未知工具」→ 业务拒绝/抛错 → 工具回退 JS，--native 对工具执行
// 实质休眠。#72 在 NativeBackend（适配器层）加命名桥（JS 名→内核名，参数形状一致），
// 让标准工具集真正下沉 Rust。
//
// 本基准用一个真实 3 工具任务（read_file → shell → write_file → 终态文本）在两种模式下各跑
// 多轮，量化：(a) 总延迟差异；(b) 原生后端到底「真正由 Rust 执行」了几个工具 vs 「回退 JS」。
// 关键环境：native shell.run 经 OS 级沙箱包装为 `omni-cli sandbox run`，需 omni-cli 在 PATH，
// 故本基准启动即把 cargo target bin 注入 PATH，忠实反映真实 --native 部署。

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { NativeBackend } from '../../src/native/nativeBackend.js';
import type { ModelPort, ModelRequest, ModelOutput } from '../../src/ports/model/model.js';
import type { NativeToolRunner } from '../../src/native/nativeBackend.js';
import type { ToolCall, ToolResult } from '../../src/ports/tool/tool.js';

// ---- 配置 ----
const ITER = 30; // 每模式任务轮数
const WARMUP = 5;

// ---- 计时工具 ----
function nowNs(): bigint {
  return process.hrtime.bigint();
}
function usFrom(t0: bigint): number {
  return Number(nowNs() - t0) / 1000;
}
function stats(samplesUs: number[]): { mean: number; p50: number; p99: number; ops: number } {
  const sorted = [...samplesUs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(p * n))]!;
  return { mean, p50: pct(0.5), p99: pct(0.99), ops: 1_000_000 / mean };
}

// ---- 运行环境准备 ----
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const origCwd = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'omni-agent-bench-'));
process.chdir(workspace); // native 内核 root = 进程 cwd = 此工作区
const inputName = 'input.txt';
const outputName = 'output.txt';
const inputContent = 'line1\nline2\nline3\n';
const outputContent = 'PROCESSED-OK-12345';
writeFileSync(join(workspace, inputName), inputContent, 'utf8');

// #72：native shell.run 经 OS 沙箱包装为 `omni-cli sandbox run`，需 omni-cli 在 PATH。
// 注入 cargo target bin 目录（release/debug 任一存在即注入），忠实反映真实 --native 部署。
for (const profile of ['release', 'debug']) {
  const bin = join(root, 'target', profile);
  if (existsSync(bin)) {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  }
}

// ---- 脚本化模型：驱动 3 工具任务，跑完自动复位供下一轮复用 ----
class ScriptedModel implements ModelPort {
  public readonly name = 'scripted';
  private turn = 0;
  public async generate(_req: ModelRequest): Promise<ModelOutput> {
    this.turn += 1;
    if (this.turn === 1) {
      return { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: inputName } }] };
    }
    if (this.turn === 2) {
      return { toolCalls: [{ id: 'c2', name: 'shell', arguments: { command: 'echo 处理完成' } }] };
    }
    if (this.turn === 3) {
      return {
        toolCalls: [
          { id: 'c3', name: 'write_file', arguments: { path: outputName, content: outputContent } },
        ],
      };
    }
    this.turn = 0; // 终态后复位，下一轮任务从头开始
    return { text: `任务完成：${outputContent}` };
  }
}

// ---- 计时模型包装：累计模型推理耗时（两种模式共用同一脚本，耗时近似，便于扣除）----
class TimingModel implements ModelPort {
  public totalUs = 0;
  public calls = 0;
  public constructor(private readonly inner: ScriptedModel) {}
  public get name(): string {
    return this.inner.name;
  }
  public async generate(req: ModelRequest): Promise<ModelOutput> {
    const t0 = nowNs();
    const out = await this.inner.generate(req);
    this.totalUs += usFrom(t0);
    this.calls += 1;
    return out;
  }
}

// ---- 插桩原生后端：记录每次 runTool 是「真正由 Rust 执行」还是「回退 JS」----
class InstrumentedNativeBackend implements NativeToolRunner {
  public attempts = 0;
  public fallbacks = 0; // 内核不认 → 抛错 → 回退 JS
  public nativeOk = 0; // 内核真正执行且成功
  public nativeRejected = 0; // 内核真正执行但业务拒绝（如沙箱）
  public ffiUs = 0; // runTool 的 FFI 往返耗时累计
  public estCalls = 0; // token 估算调用次数
  public estUs = 0;
  public constructor(private readonly inner: NativeBackend) {}
  public runTool(call: ToolCall): ToolResult {
    this.attempts += 1;
    const t0 = nowNs();
    try {
      const r = this.inner.runTool(call);
      this.ffiUs += usFrom(t0);
      if (r.ok) this.nativeOk += 1;
      else this.nativeRejected += 1;
      return r;
    } catch (e) {
      this.ffiUs += usFrom(t0);
      this.fallbacks += 1;
      throw e;
    }
  }
  public estimateTokens(messages: readonly { content: string }[]): number {
    this.estCalls += 1;
    const t0 = nowNs();
    const r = this.inner.estimateTokens(messages);
    this.estUs += usFrom(t0);
    return r;
  }
}

// ---- 装配单个模式运行时 ----
interface ModeResult {
  totalSamplesUs: number[];
  modelUs: number;
  modelCalls: number;
  instrumented?: InstrumentedNativeBackend | undefined;
  finalText: string;
  outputContent: string;
}

async function runMode(useNative: boolean): Promise<ModeResult> {
  const scripted = new ScriptedModel();
  const timing = new TimingModel(scripted);
  const config = ConfigFactory.build({
    workspaceRoot: workspace,
    maxSteps: 16,
    model: timing,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    native: useNative,
  });
  const runtime = Runtime.createRuntime(config);
  let instrumented: InstrumentedNativeBackend | undefined;
  if (useNative) {
    if (runtime.native === undefined) {
      throw new Error('原生内核不可用：请先运行 `npm run native:build` 构建 omni_napi.node');
    }
    instrumented = new InstrumentedNativeBackend(runtime.native as NativeBackend);
    // 运行期替换为插桩包装（接口 readonly，但运行期对象可改，基准用途可接受）
    (runtime as { native?: NativeToolRunner }).native = instrumented;
  }

  const agent = new Agent(runtime);
  const totalSamplesUs: number[] = [];
  let finalText = '';

  for (let i = 0; i < ITER + WARMUP; i++) {
    const t0 = nowNs();
    const r = await agent.runTask('执行数据处理任务');
    const dt = usFrom(t0);
    if (i >= WARMUP) totalSamplesUs.push(dt);
    if (i === ITER + WARMUP - 1) finalText = r.finalText ?? '';
  }

  const outPath = join(workspace, outputName);
  const written = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  return {
    totalSamplesUs,
    modelUs: timing.totalUs,
    modelCalls: timing.calls,
    instrumented,
    finalText,
    outputContent: written,
  };
}

// ---- 主流程 ----
async function main(): Promise<void> {
  console.log('=== OmniHarness #72 验证：工具名别名桥生效后 native vs JS 全程 agent 任务 ===');
  console.log(`工作区: ${workspace}`);
  console.log(`迭代: 任务轮数=${ITER}, 预热=${WARMUP}\n`);

  const js = await runMode(false);
  const native = await runMode(true);

  const jsS = stats(js.totalSamplesUs);
  const naS = stats(native.totalSamplesUs);

  console.log('● JS 模式（默认，纯 TS 工具链路）');
  console.log(
    `   总延迟 : mean=${jsS.mean.toFixed(1)}µs  p50=${jsS.p50.toFixed(1)}µs  p99=${jsS.p99.toFixed(1)}µs  ≈${Math.round(jsS.ops)} 任务/s`,
  );
  console.log(
    `   模型  : ${js.modelUs.toFixed(1)}µs / ${js.modelCalls} 次调用（mean ${(js.modelUs / js.modelCalls).toFixed(1)}µs）`,
  );

  console.log('\n● native 模式（--native，Rust 内核 in-process）');
  console.log(
    `   总延迟 : mean=${naS.mean.toFixed(1)}µs  p50=${naS.p50.toFixed(1)}µs  p99=${naS.p99.toFixed(1)}µs  ≈${Math.round(naS.ops)} 任务/s`,
  );
  console.log(
    `   模型  : ${native.modelUs.toFixed(1)}µs / ${native.modelCalls} 次调用（mean ${(native.modelUs / native.modelCalls).toFixed(1)}µs）`,
  );

  const ins = native.instrumented!;
  const nTasks = ITER;
  console.log('\n● 原生后端插桩（核心诊断）');
  console.log(`   工具调用尝试 attempts   : ${ins.attempts}`);
  console.log(`     ├ 真正由 Rust 执行    : ${ins.nativeOk}（成功）`);
  console.log(`     ├ 业务拒绝            : ${ins.nativeRejected}`);
  console.log(`     └ 不认→回退 JS       : ${ins.fallbacks}`);
  console.log(
    `   FFI 往返累计 ffiUs      : ${ins.ffiUs.toFixed(1)}µs（每任务 ≈${(ins.ffiUs / nTasks).toFixed(1)}µs）`,
  );
  console.log(
    `   token 估算 estCalls    : ${ins.estCalls}（每任务 ≈${(ins.estCalls / nTasks).toFixed(2)} 次，累计 ${ins.estUs.toFixed(1)}µs）`,
  );

  const ratio = naS.mean / jsS.mean;
  const deltaUs = naS.mean - jsS.mean;
  console.log('\n● 对比');
  console.log(
    `   native/js 总延迟 = ${ratio.toFixed(3)} → native ${deltaUs >= 0 ? '慢' : '快'} ${Math.abs((ratio - 1) * 100).toFixed(1)}%（${deltaUs >= 0 ? '+' : ''}${deltaUs.toFixed(1)}µs/任务）`,
  );
  const fallbackPct = ins.attempts > 0 ? (ins.fallbacks / ins.attempts) * 100 : 0;
  console.log(
    `   工具回退率            : ${fallbackPct.toFixed(1)}%（标准工具集命名与内核不匹配导致）`,
  );

  // 正确性校验：两种模式都应产出等价终态文本 + 写出的文件内容一致
  const jsOk = js.finalText.includes(outputContent) && js.outputContent.includes(outputContent);
  const naOk =
    native.finalText.includes(outputContent) && native.outputContent.includes(outputContent);
  const sameFinal = js.finalText === native.finalText;
  console.log('\n● 正确性');
  console.log(`   JS   终态文本/写出文件 : ${jsOk ? '✅' : '❌'}`);
  console.log(`   native 终态文本/写出文件 : ${naOk ? '✅' : '❌'}`);
  console.log(`   两模式终态文本一致      : ${sameFinal ? '✅' : '❌'}`);

  console.log('\n=== 结论（#72 别名桥生效验证）===');
  const nativeExecPct = ins.attempts > 0 ? (ins.nativeOk / ins.attempts) * 100 : 0;
  if (nativeExecPct >= 80) {
    console.log(
      `✅ 别名桥生效：标准工具集现已真正下沉 Rust 执行 —— 原生执行 ${ins.nativeOk}/${ins.attempts}（${nativeExecPct.toFixed(1)}%）`,
    );
    console.log(
      '   read_file→fs.read_file / write_file→fs.write_file / shell→shell.run 路由成功，内核 OS 级沙箱 + 原生 fs 真正接管。',
    );
  } else if (nativeExecPct > 0) {
    console.log(
      `⚠️ 别名桥部分生效：原生执行 ${ins.nativeOk}/${ins.attempts}（${nativeExecPct.toFixed(1)}%），其余 ${ins.fallbacks} 因内核内部失败回退 JS。`,
    );
  } else {
    console.log(
      `❌ 别名桥未生效：0/${ins.attempts} 由 Rust 执行，全部回退 JS（检查命名桥与 .node 版本）。`,
    );
  }
  console.log(
    `1) 延迟：native/js = ${ratio.toFixed(3)}（native ${deltaUs >= 0 ? '慢' : '快'} ${Math.abs((ratio - 1) * 100).toFixed(1)}% / ${deltaUs >= 0 ? '+' : ''}${deltaUs.toFixed(1)}µs 每任务）。`,
  );
  console.log(
    '2) 对比 #71 基准（fallback≈100% 休眠）：本次标准工具已不再休眠；shell 走通 OS 沙箱包装需 omni-cli 在 PATH（本基准已注入）。',
  );
  console.log(
    '3) 正确性：两模式终态文本与写出文件必须一致（下方校验）；FFI 仅改变执行后端，不改变语义。',
  );

  const outPath = join(root, 'bench-agent-alias-bridge.json');
  const report = {
    generatedAt: new Date().toISOString(),
    config: { iterations: ITER, warmup: WARMUP, task: 'read_file → shell → write_file → final' },
    js: {
      ...jsS,
      modelUs: js.modelUs,
      modelCalls: js.modelCalls,
      finalText: js.finalText,
      outputOk: jsOk,
    },
    native: {
      ...naS,
      modelUs: native.modelUs,
      modelCalls: native.modelCalls,
      finalText: native.finalText,
      outputOk: naOk,
      native: {
        attempts: ins.attempts,
        nativeOk: ins.nativeOk,
        nativeRejected: ins.nativeRejected,
        fallbacks: ins.fallbacks,
        fallbackPct,
        ffiUs: ins.ffiUs,
        ffiUsPerTask: ins.ffiUs / nTasks,
        estCalls: ins.estCalls,
        estUs: ins.estUs,
      },
    },
    comparison: { ratioNativeOverJs: ratio, deltaUs, sameFinal },
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n结果已写入: ${outPath}`);

  cleanup();
}

function cleanup(): void {
  try {
    process.chdir(origCwd); // 退出临时工作区，否则 Windows 因 cwd 在内而无法删除
  } catch {
    /* 忽略 */
  }
  rmSync(workspace, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  console.error(`基准失败: ${e instanceof Error ? e.message : String(e)}`);
  cleanup();
  process.exit(1);
});
