// capability_swebench.mjs —— SWE-bench 风格能力基准（自包含、可离线、零 key 可跑）
//
// 目的：把报告 #20 的 P3 诚实缺口（"OmniHarness 尚未跑 SWE-bench，能力分数维度暂无
// apples-to-apples 对照"）变成可机械验证的能力基线框架。
//
// 两套件同跑：
//   1) 确定性基建套件（mode=scripted）：用 ScriptedModel replay 修复步骤，证明
//      「读文件 → 应用补丁 → 跑测试 → 评分」真实链路在 OmniHarness 内可用（零 API Key）。
//   2) 对照（gold/negative）：阳性对照直接套 goldPatch 必过（评分器不假阴），
//      阴性对照仅 seed 不修复必不过（评分器不假阳）。二者全有效能力分数才成立。
//
// 真实 LLM 能力分数（mode=live）：需在 DEEPSEEK_API_KEY 可用时显式 `--live` 开启，
// 经 OpenAiCompatibleModel + BudgetedModel 成本护栏跑同一套件。默认不跑，避免无提示烧钱。
//
// 任务定义复用 benchmark/swebenchTasks.mjs（与 evals/live/bench.mjs --swebench 共享，避免重复）。
//
// 用法：
//   node benchmark/capability_swebench.mjs                 # 基建套件 + 对照（零 key，约数秒）
//   DEEPSEEK_API_KEY=sk-xxx node benchmark/capability_swebench.mjs --live   # 真实能力分数
//   node benchmark/capability_swebench.mjs --drift-selftest --max-drift-alarms 0  # 反漂移门禁自检 + 退出码闸
//
// 输出：benchmark/capability-swebench.json（基建 + 对照 + 可选 live）+ 控制台报告。

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Swebench } from '../dist/src/eval/swebench.js';
import { ScriptedModel } from '../dist/src/eval/scriptedModel.js';
import { EditDriftDetector } from '../dist/src/eval/editDriftDetector.js';
import { LiveCredentials } from '../dist/src/eval/liveCredentials.js';
import { ReasoningRouter } from '../dist/src/eval/reasoningRouter.js';
import { SWEBENCH_LITE_TASKS, buildEnhancedTasks } from './swebenchTasks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'capability-swebench.json');

// 增强提示：要求用 read_file + apply_patch 工具完成修复（规范 agent 工具使用，不泄露答案）。
// 这是合理的 agent 引导（对标成熟 agent 的 system 指令），仅规范工具使用方式。
const ENHANCED_TASKS = buildEnhancedTasks(SWEBENCH_LITE_TASKS);

const scriptedModelFor = (task) => new ScriptedModel(task.script ?? [], '任务完成（swebench）');

// ---------- T4.2 / T5.5 接线（本轮）：反漂移检测 + 推理强度路由 ----------
// 反漂移检测器：注入 runSweSuite / runControls，由评测器在每个任务的**独立临时工作区**里
// 于「补丁应用前 / 后」各取一次指纹快照，差异喂给 detector.record()；命中的
// oscillation / thrash 告警进结果 → 控制台报告 + `--max-drift-alarms N` 退出码闸。
// 检测器状态由评测器按工作区重置（跨工作区混用指纹历史会把同名文件误判为振荡）。
// `--drift-selftest` 另跑一条已知 A→B→A 振荡的探针流做门禁自检（检测器失效即 exit 3）。
const DRIFT_DETECTOR = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 5 });
// 推理强度路由：按任务难度分层给档（易 low / 中 medium / 难 high），透传为模型请求 reasoning_effort。
const ROUTER = new ReasoningRouter();
const ROUTED_EFFORT = new Map(ENHANCED_TASKS.map((t) => [t.id, ROUTER.route(t.prompt)]));
const ROUTING_BUDGET = ROUTER.compareBudgets(ENHANCED_TASKS.map((t) => t.prompt));

/** 解析 --max-drift-alarms（缺省 Infinity = 只报告不拦截；给值即成为退出码闸）。 */
function maxDriftAlarms() {
  const i = process.argv.indexOf('--max-drift-alarms');
  if (i === -1) return Number.POSITIVE_INFINITY;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * 反漂移门禁自检（--drift-selftest）：把已知的 A→B→A 振荡与同文件高频重写喂进**同一个**
 * detector 实例，要求它确实报出 oscillation。自检失败即 exit 3——检测器被改坏时不允许静默放行
 * （自检命中的告警同样计入 `--max-drift-alarms` 闸，故这条路径本身也验证「告警 → 退出码」接线）。
 * @returns 自检命中的告警条数
 */
function driftSelfTest() {
  if (!process.argv.includes('--drift-selftest')) return 0;
  const probe = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 5 });
  const oscillation = ['a', 'b', 'a'].map((revision) =>
    probe.record({ file: 'probe.js', revision }),
  );
  const thrash = [];
  for (let i = 0; i < 8; i++) thrash.push(probe.record({ file: 'grind.js', revision: `r${i}` }));
  const alarms = [...oscillation, ...thrash].filter((a) => a !== undefined);
  const hasOscillation = alarms.some((a) => a.kind === 'oscillation');
  console.log(
    `[capability:swebench] 反漂移门禁自检：告警 ${alarms.length} 条` +
      `（oscillation=${hasOscillation ? '已命中' : '未命中'}）`,
  );
  if (!hasOscillation) {
    console.error('[capability:swebench] ❌ 反漂移自检失败：A→B→A 振荡未被告警，检测器已失效。');
    process.exit(3);
  }
  for (const alarm of alarms)
    console.log(`   ⚠️ [自检·${alarm.kind}] ${alarm.file}: ${alarm.detail}`);
  return alarms.length;
}

/** 打印推理强度路由结果（难度分层 → 档位 → 相对预算）。 */
function printRouting() {
  const byEffort = { low: 0, medium: 0, high: 0 };
  for (const effort of ROUTED_EFFORT.values()) byEffort[effort] += 1;
  console.log(
    `[capability:swebench] 推理强度路由：low=${byEffort.low} medium=${byEffort.medium} high=${byEffort.high}` +
      `（一刀切 high 预算 ${ROUTING_BUDGET.fixedTotal} → 路由后 ${ROUTING_BUDGET.routedTotal}，` +
      `Δ=${ROUTING_BUDGET.delta}）`,
  );
}

/** 汇总并（可选）拦截漂移告警；超过 --max-drift-alarms 即非 0 退出。 */
function driftGate(scripted, controls) {
  const scriptedAlarms = scripted.results.reduce((n, r) => n + (r.driftAlarms?.length ?? 0), 0);
  const goldAlarms = controls.gold.reduce((n, r) => n + (r.driftAlarms?.length ?? 0), 0);
  const total = scriptedAlarms + goldAlarms + driftSelfTest();
  console.log(
    `[capability:swebench] 反漂移检测：告警 ${total} 条（套件 ${scriptedAlarms} / gold 对照 ${goldAlarms} / 自检另计）`,
  );
  const cap = maxDriftAlarms();
  if (total > cap) {
    console.error(
      `[capability:swebench] ❌ 反漂移告警 ${total} > 上限 ${cap}：同一文件反复改（oscillation/thrash）` +
        '是失控前兆，按门禁非 0 退出。',
    );
    process.exit(1);
  }
}

// ---------- 官方 SWE-bench Verified 子集（B1 官方跑分真实接线，免 Docker、免云）----------
// 原生本地执行器（git worktree 检出 + uv venv + 应用补丁 + pytest 判定），零 Docker、零云。
// 用法（执行须在你侧具备 git + uv + 网络 的环境）：
//   node benchmark/capability_swebench.mjs --verified <swe_bench_verified.json> \
//     --predictions <preds.jsonl> [--concurrency N] \
//     [--instances id1,id2 | --instance-list <file>] \
//     [--repo-base https://gitee.com/] [--repo-mirrors benchmark/swebench-gitee-mirrors.json] \
//     [--env-pins benchmark/swebench-env-pins.json]
//     [--jsonl <进度文件>]             # 增量落盘+断点续跑+并发锁（长批/易中断必加；重启自动跳过已完成、防两进程互踩）
// 子集口径：`--instances` / `--instance-list` 只对指定实例出分（pilot/分批用）。
//   不给时覆盖全部实例（官方 500 满分口径）。子集分数**不可**当作官方满分口径引用。
// 模型补丁（predictions）由我们的 live agent 在具备 git+uv+网络的环境生成；本命令只负责"打分"。
// 镜像通道：`--repo-base` + `--repo-mirrors` 用于把克隆重定向到国内镜像（上游 slug → 镜像 slug），
//   实测 Gitee 覆盖 12 个 SWE-bench 仓库中的 11 个、且 base_commit 全部命中（见镜像映射文件注释）。
//   两参数缺省时零行为变更（直连 https://github.com/，无重定向）。
// 环境约束：`--env-pins` 按仓库补 pip 约束（如 flask 的 Werkzeug<3），修复「不设上界的开发期运行时
//   依赖被解析到过新主版本」导致老测试套件崩的保真度缺口。缺省时零行为变更。
// 保真度边界：env 由 repo 自述 + uv 重建，不等同官方 Docker 镜像；用于本地迭代/小批量自测。
// 抗中断：加 --jsonl 后进度逐题 append 落盘，会话被杀后重跑同命令即从已完成处续跑；同一 --jsonl 由文件锁互斥，杜绝并发踩踏。
// ---- 增量评分的断点续跑 + 并发锁能力（根因修复：抗会话中断、抗重复并发踩踏）----
// 在 --verified 调用上加 --jsonl <进度文件>：进度逐题 append 落盘，中途被杀后重跑同命令即从已完成处
// 续跑；同一 --jsonl 由文件锁互斥，杜绝两个进程抢同一 --out / 同一仓库串行锁而死锁或互相覆盖。
// （原 runVerifiedSuite 一次性跑完才返回报告，会话一结束即全废，正是此前反复丢进度的根因。）

/** 并发锁心跳阈值：超过该时长无心跳即判定为会话残留僵尸锁，允许清掉重拿（默认 2 分钟）。 */
const LOCK_STALE_MS = 120 * 1000;

/** 当前持有的心跳定时器（release 时清理）。 */
let activeLockInterval = null;

/**
 * 获取评分并发锁：原子创建 <lockPath>（wx），成功则写入心跳并启动 15s 心跳定时器；
 * 若已存在且心跳新鲜（另一进程仍活着）则直接退出，若心跳陈旧（会话残留僵尸锁）则清掉重拿。
 * 用「心跳时间戳」而非 pid 判活，规避 Windows/MSYS 下 pid 跨子系统不可比对导致并发锁失效的问题。
 * @param lockPath 锁文件路径（通常为 <jsonl>.lock）。
 * @returns 锁文件 fd（须在 finally 中交 releaseScoreLock 释放）。
 */
function acquireScoreLock(lockPath) {
  const writeHb = (fd) => {
    try {
      writeSync(fd, JSON.stringify({ hb: Date.now() }));
    } catch {
      /* ignore */
    }
  };
  const openNew = () => {
    const fd = openSync(lockPath, 'wx');
    writeHb(fd);
    activeLockInterval = setInterval(() => writeHb(fd), 15000);
    return fd;
  };
  try {
    return openNew();
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'EEXIST') {
      try {
        const raw = readFileSync(lockPath, 'utf8');
        const hb = Number(JSON.parse(raw).hb) || 0;
        if (Date.now() - hb < LOCK_STALE_MS) {
          console.error(
            `[lock] 另一个评分进程仍在运行（锁 ${lockPath} 心跳 ${Math.round((Date.now() - hb) / 1000)}s 前），` +
              '拒绝并发；如确认无残留进程，请删除该锁文件后再跑。',
          );
          process.exit(1);
        }
      } catch {
        /* 锁文件损坏 ⇒ 视为僵尸锁 */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      try {
        return openNew();
      } catch (e2) {
        throw e2;
      }
    }
    throw err;
  }
}

/**
 * 释放评分并发锁（无论成败都应在 finally 中调用）：清心跳定时器、关 fd、删锁文件。
 * @param fd acquireScoreLock 返回的锁 fd。
 * @param lockPath 锁文件路径。
 */
function releaseScoreLock(fd, lockPath) {
  if (activeLockInterval !== null) {
    clearInterval(activeLockInterval);
    activeLockInterval = null;
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * 从增量进度文件读取已完成的实例 id 集合（断点续跑依据）。
 * @param jsonlPath 增量进度文件路径。
 * @returns 已完成实例 id 集合。
 */
function loadDoneIds(jsonlPath) {
  const ids = new Set();
  if (!existsSync(jsonlPath)) return ids;
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.id === 'string') ids.add(obj.id);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return ids;
}

/**
 * 从增量进度文件聚合最终汇总报告（与 runVerifiedSuite 返回形态一致，可直接喂 formatVerifiedReport）。
 * @param jsonlPath 增量进度文件路径。
 * @param backend 执行后端标识（恒 native）。
 * @param subsetSize 子集实例数（用于子集口径标注）。
 * @param subsetIds 子集 id 列表（undefined 表示全覆盖官方口径）。
 * @returns 汇总报告。
 */
function buildVerifiedReport(jsonlPath, backend, subsetSize, subsetIds) {
  const records = [];
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      /* 忽略损坏行 */
    }
  }
  const resolved = records.filter((r) => r.resolved === true).length;
  const envErrors = records.filter((r) => r.envError === true).length;
  return {
    source: 'official-swebench-verified',
    backend,
    subsetNote:
      subsetIds !== undefined ? `${subsetSize}/500 子集口径（非官方满分口径）` : undefined,
    total: records.length,
    resolved,
    failed: records.length - resolved - envErrors,
    envErrors,
    results: records,
    totalDurationMs: 0,
    generatedAt: new Date().toISOString(),
  };
}

const verifiedIdx = process.argv.indexOf('--verified');
if (verifiedIdx !== -1) {
  const verifiedPath = process.argv[verifiedIdx + 1];
  const predsIdx = process.argv.indexOf('--predictions');
  const predsPath = predsIdx !== -1 ? process.argv[predsIdx + 1] : undefined;
  const concIdx = process.argv.indexOf('--concurrency');
  const concurrency = concIdx !== -1 ? Number(process.argv[concIdx + 1]) : 1;
  const baseIdx = process.argv.indexOf('--repo-base');
  const repoBaseUrl = baseIdx !== -1 ? process.argv[baseIdx + 1] : undefined;
  const mirrorIdx = process.argv.indexOf('--repo-mirrors');
  const mirrorPath = mirrorIdx !== -1 ? process.argv[mirrorIdx + 1] : undefined;
  const pinsIdx = process.argv.indexOf('--env-pins');
  const pinsPath = pinsIdx !== -1 ? process.argv[pinsIdx + 1] : undefined;
  // 镜像映射为可选：未给则在执行器内保持空映射 ⇒ 克隆 URL 与历史完全一致（零行为变更）。
  let repoMirrors = {};
  if (mirrorPath !== undefined) {
    const parsed = JSON.parse(readFileSync(mirrorPath, 'utf8'));
    repoMirrors = parsed.mirrors ?? {};
    console.log(
      `[capability:swebench:verified] 镜像映射 ${Object.keys(repoMirrors).length} 条（${mirrorPath}）`,
    );
  }
  // 环境约束为可选：未给则保持空映射 ⇒ 安装阶梯与历史一致（零行为变更）。
  let envPins = {};
  if (pinsPath !== undefined) {
    const parsed = JSON.parse(readFileSync(pinsPath, 'utf8'));
    envPins = parsed.pins ?? {};
    console.log(
      `[capability:swebench:verified] 环境约束 ${Object.keys(envPins).length} 条（${pinsPath}）`,
    );
  }

  // 增量进度文件（可选）：给 --jsonl 即开启「逐题落盘 + 断点续跑 + 并发锁」，长批/易中断场景必加。
  const jsonlIdx = process.argv.indexOf('--jsonl');
  const jsonlPath = jsonlIdx !== -1 ? process.argv[jsonlIdx + 1] : undefined;

  const { SwebenchVerified } = await import('../dist/src/eval/swebenchVerified.js');
  const { NativeExecutor } = await import('../dist/src/eval/nativeExecutor.js');
  const executor = new NativeExecutor({
    repoCacheRoot: join(__dirname, '..', 'eval-data', 'repos'),
    ...(repoBaseUrl !== undefined ? { repoBaseUrl } : {}),
    ...(Object.keys(repoMirrors).length > 0 ? { repoMirrors } : {}),
    ...(Object.keys(envPins).length > 0 ? { envPins } : {}),
  });

  console.log(`[capability:swebench:verified] backend=native executor=${executor.describe()}`);
  const tasks = SwebenchVerified.loadVerified(verifiedPath);
  console.log(`[capability:swebench:verified] 加载 ${tasks.length} 个官方 Verified 实例`);

  // 子集过滤：pilot/分批跑分时为**只对已生成预测的实例**出分，避免未预测实例被计为失败
  // 而把分母稀释成 500（那不是「真实分数」，是「没跑完」）。
  // 注意：官方 apples-to-apples 口径要求覆盖全部 500；子集分数须显式标注为子集口径。
  const instIdx = process.argv.indexOf('--instances');
  const listIdx = process.argv.indexOf('--instance-list');
  let subsetIds;
  if (instIdx !== -1) {
    subsetIds = (process.argv[instIdx + 1] ?? '').split(',').filter((s) => s.length > 0);
  } else if (listIdx !== -1) {
    subsetIds = readFileSync(process.argv[listIdx + 1], 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  }
  let suiteTasks = tasks;
  if (subsetIds !== undefined) {
    const want = new Set(subsetIds);
    suiteTasks = tasks.filter((t) => want.has(t.id));
    console.log(
      `[capability:swebench:verified] ⚠️ 子集口径：${suiteTasks.length}/${tasks.length} 实例` +
        '（非官方 500 满分口径，仅用于分批/pilot；报告中 total 即为子集大小）',
    );
  }

  // ---- 第二关（机器化，2026-09-26）：**gold 对照** ----
  // 「放行 ≠ 有效」在本仓早有两关纪律（空补丁必判 false / gold 必判 true），但此前只在文档与手工 smoke 里，
  // 判分主链路没有它。实测代价：`astropy__astropy-12907` 的官方 gold patch 在该原生环境里**判不过**
  // （缺 hypothesis → 补 hypotheses 后缺 erfa…），而报告把它记成「模型失败」——
  // 于是「30 题 1/30」里到底有多少是环境不可信，无法区分。
  // 本开关用官方 gold patch 当"预测"跑**同一判分链路**（零成本、不调模型）：
  //   gold resolved=true ⇒ 该实例判分链路可信；false ⇒ **不可信**，其"模型失败"结论不得采信。
  const goldControl = process.argv.includes('--gold-control');
  const predictions = new Map();
  if (goldControl) {
    for (const t of suiteTasks) {
      if (typeof t.goldPatch === 'string' && t.goldPatch.length > 0) {
        predictions.set(t.id, t.goldPatch);
      }
    }
    console.log(
      `[gold-control] 以官方 gold patch 充当预测：${predictions.size}/${suiteTasks.length} 条` +
        '（判据：须 resolved=true，否则该实例判分链路不可信）',
    );
  } else if (predsPath === undefined) {
    console.error(
      '[capability:swebench:verified] ❌ 缺 --predictions：官方 Verified 需先由我们的 live agent 在具备 git+uv+网络的环境生成模型补丁（predictions.jsonl）。' +
        ' 本命令只负责"打分"一环（fail-closed）。',
    );
    process.exit(1);
  } else {
    for (const line of readFileSync(predsPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      const obj = JSON.parse(t);
      if (typeof obj.instance_id === 'string' && typeof obj.model_patch === 'string') {
        predictions.set(obj.instance_id, obj.model_patch);
      }
    }
    console.log(`[capability:swebench:verified] 载入 ${predictions.size} 条预测`);
  }

  const outIdx = process.argv.indexOf('--out');
  const reportPath =
    outIdx !== -1
      ? process.argv[outIdx + 1]
      : join(
          __dirname,
          goldControl ? 'capability-swebench-gold.json' : 'capability-swebench-verified.json',
        );

  // ---- 判分可信度标注（2026-09-26）----
  // 起因（实测）：Verified-30 上跑 `--gold-control` ⇒ 官方 gold patch 只有 **4/30** 判 resolved
  // （sympy 4 题；astropy/django/matplotlib/xarray/pytest/scikit-learn/sphinx 共 26 题 gold 都判不过），
  // 而主报告的「模型失败 29」把这些**不可信的失败**一并算成了能力分。
  // 故：给主链路一个显式的可信度闸——`--gold-report <gold.json>` 提供 gold 对照报告，
  // 本命令会打印「本次 N 个实例中仅 M 个判分链路可信」，未通过 gold 的实例其"未通过"**不代表模型能力**。
  const goldReportIdx = process.argv.indexOf('--gold-report');
  const goldReportPath = goldReportIdx !== -1 ? process.argv[goldReportIdx + 1] : undefined;
  /** gold 对照里 resolved=true 的实例集合；未提供/文件缺失返回 null（= 未校验）。 */
  function judgeValidIds() {
    if (goldReportPath === undefined || !existsSync(goldReportPath)) return null;
    try {
      const r = JSON.parse(readFileSync(goldReportPath, 'utf8'));
      return new Set((r.results ?? []).filter((x) => x.resolved === true).map((x) => x.id));
    } catch {
      return null;
    }
  }
  /**
   * gold 对照报告落盘路径。
   *
   * ⚠️ 这里修的是一个**真缺陷**（2026-09-26 实测）：`--gold-report` 此前**只被读、从不被写**——
   * 于是文档里那套「先跑 `--gold-control --gold-report g.json`，再用 `--gold-report g.json` 复核后续分数」
   * 的两步工作流**根本不可能成立**（g.json 永远不会出现，复核永远走「未校验」分支）。
   * 显现现场：django 14 题 gold 全过，收尾仍打印「判分可信度未校验」。
   * @returns gold 报告应写入的路径。
   */
  function goldReportOutPath() {
    if (goldReportPath !== undefined) return goldReportPath;
    return reportPath.endsWith('.json')
      ? `${reportPath.slice(0, -'.json'.length)}.gold.json`
      : `${reportPath}.gold.json`;
  }

  /**
   * 写入 gold 对照报告（仅 `--gold-control` 时）。产出的文件正是 {@link judgeValidIds} 要读的格式。
   * @param report 本次报告。
   * @returns 无返回值。
   */
  function writeGoldReport(report) {
    if (!goldControl) return;
    const path = goldReportOutPath();
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    console.log(
      `[capability:swebench:verified] gold 对照报告已写入: ${path}（供后续 --gold-report 复核）`,
    );
  }

  /**
   * 打印判分可信度（未提供 gold 报告时给出提示）。
   * @param report 本次评分报告。
   * @returns 无返回值。
   */
  function printJudgeValidity(report) {
    // 本次**就是** gold 对照 ⇒ 可信度结论由本次结果直接给出，不必（也不能）去读一份外部报告：
    // 旧实现无条件去读 `--gold-report` 文件，导致 gold 运行收尾还在喊「未校验」，是自相矛盾的假信号。
    if (goldControl) {
      const rows = report.results ?? [];
      const bad = rows.filter((r) => r.resolved !== true);
      console.log(
        bad.length === 0
          ? `✅ 判分可信度（gold 对照）：${rows.length}/${rows.length} 实例的 gold 补丁判 resolved —— 该子集判分链路可信。`
          : `⚠️ 判分可信度（gold 对照）：${rows.length - bad.length}/${rows.length} 通过；` +
              `未通过的 ${bad.length} 个实例**判分链路不可信**，其「模型未通过」不含能力信息：`,
      );
      for (const r of bad) console.log(`   ❌ ${r.id} — ${r.reason ?? '无原因'}`);
      return;
    }
    const valid = judgeValidIds();
    const scored = (report.results ?? []).map((r) => r.id);
    if (valid === null) {
      console.log(
        'ℹ️ 判分可信度未校验：建议先跑 `npm run eval:swebench:gold`（gold 对照，会写入 --gold-report），再用 --gold-report 复核本次分数。',
      );
      return;
    }
    const untrusted = scored.filter((id) => !valid.has(id));
    console.log(
      untrusted.length === 0
        ? `✅ 判分可信度：本次 ${scored.length} 个实例全部通过 gold 对照。`
        : `⚠️ 判分可信度：本次 ${scored.length} 个实例中仅 ${scored.length - untrusted.length} 个通过 gold 对照；` +
            `其余 ${untrusted.length} 个的「未通过」**不代表模型能力**（环境/判分链路不可信，见看板 §21.17）。`,
    );
    if (untrusted.length > 0 && untrusted.length <= 12) {
      console.log(`   不可信实例：${untrusted.join(', ')}`);
    }
  }

  // ---- 增量 + 断点续跑 + 并发锁 模式（长批/易中断场景必走：抗会话被杀、抗重复并发踩踏）----
  // 根因：原 runVerifiedSuite 一次性跑完才返回报告，会话一结束即全废；且无任何锁，两个进程会抢同一
  // --out / 同一仓库串行锁，导致死锁或互相覆盖。本分支把进度逐题 append 到 --jsonl（永久落盘），
  // 重启自动跳过已完成 id，并用文件锁阻止并发跑分互相踩踏（含会话残留僵尸锁检测）。
  if (jsonlPath !== undefined) {
    const lockPath = `${jsonlPath}.lock`;
    const lockFd = acquireScoreLock(lockPath);
    try {
      const done = loadDoneIds(jsonlPath);
      if (done.size > 0) {
        console.log(
          `[capability:swebench:verified] 已从 ${jsonlPath} 读入 ${done.size} 个已完成实例，断点续跑`,
        );
      }
      const pending = suiteTasks.filter((t) => !done.has(t.id));
      console.log(
        `[capability:swebench:verified] 待跑 ${pending.length}/${suiteTasks.length}` +
          (pending.length < suiteTasks.length ? '（其余跳过）' : ''),
      );
      let doneThisRun = 0;
      const scoreOne = async (task) => {
        const patch = predictions.get(task.id);
        if (patch === undefined) {
          return {
            id: task.id,
            resolved: false,
            backend: executor.kind,
            reason: '未提供模型预测（predictions 缺该 instance_id）',
          };
        }
        try {
          return await executor.run(task, patch);
        } catch (err) {
          return {
            id: task.id,
            resolved: false,
            backend: executor.kind,
            reason: `executor 异常: ${String(err?.message ?? err)}`,
          };
        }
      };
      const poolSize = Math.max(1, Math.min(concurrency, pending.length || 1));
      let cursor = 0;
      const workers = Array.from({ length: poolSize }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= pending.length) return;
          const task = pending[i];
          const t0 = Date.now();
          const rec = await scoreOne(task);
          appendFileSync(jsonlPath, JSON.stringify(rec) + '\n', 'utf8');
          doneThisRun += 1;
          console.log(
            `[done] ${task.id} resolved=${rec.resolved} (${((Date.now() - t0) / 1000).toFixed(1)}s)` +
              ` — 累计 ${done.size + doneThisRun}/${suiteTasks.length}`,
          );
        }
      });
      await Promise.all(workers);
      const report = buildVerifiedReport(jsonlPath, executor.kind, suiteTasks.length, subsetIds);
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      writeGoldReport(report);
      console.log(SwebenchVerified.formatVerifiedReport(report));
      printJudgeValidity(report);
      console.log(`[capability:swebench:verified] 报告已写入: ${reportPath}`);
    } finally {
      releaseScoreLock(lockFd, lockPath);
    }
    process.exit(0);
  }

  // ---- 原一次性模式（无 --jsonl：短批/对照，行为不变）----
  const report = await SwebenchVerified.runVerifiedSuite(
    suiteTasks,
    predictions,
    executor,
    concurrency,
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  writeGoldReport(report);
  console.log(SwebenchVerified.formatVerifiedReport(report));
  printJudgeValidity(report);
  console.log(`[capability:swebench:verified] 报告已写入: ${reportPath}`);
  process.exit(0);
}

const scripted = await Swebench.runSweSuite(
  'capability-scripted',
  ENHANCED_TASKS,
  null,
  'scripted',
  {
    modelFor: scriptedModelFor,
    driftDetector: DRIFT_DETECTOR,
    reasoningFor: (task) => ROUTED_EFFORT.get(task.id),
  },
);
const controls = await Swebench.runControls(ENHANCED_TASKS, { driftDetector: DRIFT_DETECTOR });

const report = {
  suite: 'capability-swebench',
  generatedAt: new Date().toISOString(),
  scripted: {
    passed: scripted.passed,
    total: scripted.total,
    results: scripted.results,
    totalDurationMs: scripted.totalDurationMs,
  },
  controls: {
    valid: controls.valid,
    gold: controls.gold,
    negative: controls.negative,
  },
  /** T5.5：推理强度路由（按任务难度分层给档）+ 相对预算对比（一刀切 high 的对照）。 */
  reasoningRouting: {
    perTask: Object.fromEntries(ROUTED_EFFORT),
    budgets: ROUTING_BUDGET,
  },
  live: null,
};

// 真实 LLM 能力分数（需 key + 显式 --live）
const live = process.argv.includes('--live');
if (live) {
  // 凭据分层纪律：env 缺失时回退用户级配置 ~/.omniharness/omniharness.json（仓库树不放密钥）。
  const apiKey = process.env.DEEPSEEK_API_KEY ?? LiveCredentials.readUserProviderKey();
  if (!apiKey) {
    console.error(
      '[capability:swebench] --live 需要 DEEPSEEK_API_KEY（或用户级 ~/.omniharness/omniharness.json 的 providerKeys.deepseek），未提供，跳过 live。',
    );
  } else {
    const { OpenAiCompatibleModel } =
      await import('../dist/src/adapters/model/openAiCompatibleModel.js');
    const { BudgetedModel } = await import('../dist/src/adapters/model/budgetedModel.js');
    const { CostBudget } = await import('../dist/src/adapters/model/costBudget.js');
    const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    const budget = new CostBudget(0.5, new Map());
    const liveModel = new BudgetedModel(
      new OpenAiCompatibleModel({ baseUrl, apiKey, model: modelName }),
      budget,
    );
    console.log(`[capability:swebench] live 模式：用 ${modelName} @ ${baseUrl}（预算 $0.50 护栏）`);
    const liveReport = await Swebench.runSweSuite(
      'capability-live',
      ENHANCED_TASKS,
      liveModel,
      'live',
      {
        driftDetector: DRIFT_DETECTOR,
        reasoningFor: (task) => ROUTED_EFFORT.get(task.id),
      },
    );
    report.live = {
      model: modelName,
      passed: liveReport.passed,
      total: liveReport.total,
      results: liveReport.results,
      totalDurationMs: liveReport.totalDurationMs,
      costUsd: Number(budget.totalCostUsd.toFixed(4)),
    };
  }
}

writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

// ---------- 控制台 ----------
printRouting();
driftGate(scripted, controls);
console.log(Swebench.formatSweReport(scripted, controls));
if (report.live !== null) {
  console.log(
    `=== LIVE 能力分数: ${report.live.passed}/${report.live.total} 通过, 花费 $${report.live.costUsd} ===`,
  );
}
console.log(
  `\n[capability:swebench] 基建套件 ${scripted.passed}/${scripted.total} 通过；对照有效性=${controls.valid}`,
);
console.log(`[capability:swebench] 报告已写入: ${OUT}`);
if (!controls.valid) {
  console.error('[capability:swebench] ❌ 对照失效：能力分数不可信，请检查任务定义/评分器。');
  process.exit(1);
}
