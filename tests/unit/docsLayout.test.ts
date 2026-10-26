/**
 * **文档布局**判据（G20 文档瘦身，2026-10-03 第十八轮）。
 *
 * ## 它锁的是什么
 *
 * `docs/` 曾经堆了 33 份根级文档：旧审计、旧计划、旧调研与现行纪律混在一起，于是"旧数字被当现状"
 * 成了真实风险（典型：`ARCHITECTURE_SPEC.md` 自述"311 TS 文件 / 31500 行"，而当时全仓已 900+ 文件）。
 * G20 的做法是**只留 SSOT + 现行纪律 + 用户文档**，历史材料直接删除（本仓不再维护归档）。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `docs/` 根下的 `.md` **只允许**在白名单内（不在 = 有人又往根上堆文档，必须显式决定去向） |
 * | ④ | **现行索引自洽**：`docs/README.md` 与 `docs/llms.txt` 里的每个文档链接都必须指向**真实存在**的文件 |
 *
 * 判据④为什么必要：索引是"现行权威入口"的清单，一旦指向已删文件，就会把历史材料重新
 * 推给读者（尤其 `llms.txt` 是给自动化工具读的）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');

/**
 * `docs/` 根允许存在的文档（SSOT + 现行纪律 + 用户文档）。
 *
 * 新增一份根级文档 = 显式改这份白名单：逼作者回答"它属于哪一类"，而不是把历史报告随手丢在根上。
 */
const ROOT_ALLOWLIST: readonly string[] = [
  // SSOT 与当前依据
  'PROJECT_BOARD.md',
  'ARCHITECTURE_UPGRADE_2026-10.md',
  // G20-b（2026-10-03）：架构说明书按现状**重写**并回到根级 —— 这是显式决定，故白名单加一行。
  'ARCHITECTURE_SPEC.md',
  // 自进化商业落地方案研究报告（2026-10-04 显式登记）：带日期快照，市场数字为二手来源须复核。
  'EVOLUTION_COMMERCIALIZATION_2026-10.md',
  // 自进化先行研究调研与自研方案（2026-10-04 显式登记）：机制级择优学习表 + GEE 自研设计，外部数字为检索快照。
  'EVOLUTION_RD_RESEARCH_2026-10.md',
  // 进化域架构升级方案（2026-10-04 显式登记）：GEE Kernel v1 实施蓝图，配套 ADR-0008，未实现前不得当现状引用。
  // 商业化路线图剩余项裁决记录（2026-10-04 显式登记）：逐项判定「已落地 / 阻塞 / 非代码项」，防止把商业决策当成欠账。
  'COMMERCIALIZATION_GAPS_2026-10.md',
  // 协议生态现行说明（2026-10-24 显式登记）：ACP / A2A 1.0 / AG-UI 覆盖与未支持点。
  'PROTOCOL_ECOSYSTEM.md',
  // 桌面应用技术方案（2026-10-24 显式登记）：Electron + 固定 Node 侧车的提议稿，配套 ADR-0015；
  // **未评审前不得当已批准方案实施**。
  'DESKTOP_ARCHITECTURE_2026-10.md',
  'EVOLUTION_ARCH_UPGRADE_2026-10.md',
  // 目标架构蓝图（2026-10-04 显式登记）：Evolvix-Ω 终局态，Wave A–E 分波浪路线，未实现前不得当现状引用。
  'ARCHITECTURE_TARGET_2026-10.md',
  // Evolvix-Ω 架构规格书（2026-10-04 显式登记）：实现级契约/端口/模块/流程规格，全部为设计产物未实现。
  'EVOLVIX_SPEC_2026-10.md',
  // A.5 OTel 导出评估：B 级「先测后买」的裁决记录（含复评触发条件），ARCHITECTURE_TARGET §5.3 指向它
  'OTEL_EXPORT_EVALUATION_2026-10.md',
  'TRANSPORT_STACK_EVALUATION_2026-10.md',
  // 多会话并发数学调研（2026-10-25 显式登记）：锁/调度/一致性/原子写的理论映射与未做边界，
  // 配套本轮文件协调器与 shell 公平闸门的实施记录。
  'CONCURRENCY_MATH_2026-10-25.md',
  // 能力升级总规划（2026-10-25 显式登记）：独立性/桌面/长任务/多 Skill/Web+桌面五条工作流与优先级。
  'PROJECT_EVOLUTION_PLAN_2026-10-25.md',
  // Web/桌面能力矩阵（2026-10-25 显式登记）：共享层/文件/通知/更新/安全/缺口六张表。
  'WEB_DESKTOP_CAPABILITY_MATRIX.md',
  // 剩余阻塞项（2026-10-25 显式登记）：必须由外部环境/凭据才能继续的项 + 复现证据与解阻命令。
  'BLOCKERS_2026-10-25.md',
  // 长任务自锁修复（2026-10-26 显式登记）：supervisor 降级导致真实长任务从 3 分钟拖成 3 小时的复盘与修复。
  'LONG_TASK_SUPERVISOR_FIX_2026-10-26.md',
  // 现行纪律
  'CODE_STANDARD.md',
  'DEPENDENCY_POLICY.md',
  'API_STABILITY.md',
  'PORTS_CONTRACT.md',
  // 用户/第三方文档
  'README.md',
  // 一键启动与运行规范（2026-10-06 显式登记）：整体启动的**唯一规范**（前置条件/探活/停止重启/故障排查/验收）
  'STARTUP.md',
  'QUICKSTART.md',
  // CLI 参考（2026-10-06 显式登记）：从 47KB 的根 README 里拆出的子命令与旗标速查（权威来源仍是 --help）
  'CLI_REFERENCE.md',
  // Web 设计系统规范（2026-10-07 显式登记）：web/styles 打磨层与壳层的 token/层级/交互态唯一规范
  'DESIGN_SYSTEM.md',
  // 易用性审计（2026-10-09 显式登记）：产品可用性轴的**现行**审计（F1–F9 逐条带真机证据与
  // 「已修 / 未修」判定）。它不是历史报告——未修项 F8/F9 是下一轮的待办依据，修完前不得归档。
  'USABILITY_AUDIT_2026-10-09.md',
  // 长会话质量分析（2026-10-20 显式登记）：数据驱动诊断 + 修复清单，现行分析快照。
  'LONG_SESSION_QUALITY_2026-10-20.md',
  // 鹈鹕会话复盘（2026-10-19 显式登记）：单会话纵深复盘，现行分析快照。
  'PELICAN_SESSION_POSTMORTEM_2026-10-19.md',
  'PLUGIN_GUIDE.md',
  'contributing.md',
  'integration.md',
  'protocol.md',
  'DOMAIN_SLICE_TEMPLATE.md',
];

/** 递归列出目录下所有 .md（相对给定根）。 */
function markdownUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.md')) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** 读出文本里所有 markdown 链接目标（只取本地 `.md` 目标，跳过 http/锚点）。 */
function localDocLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (target.startsWith('http') || target.startsWith('#')) continue;
    out.push(target.split('#')[0]!);
  }
  return out;
}

/** 并发会话临时记录标记：出现在文件前 5 行即视为「待合并的协作便签」，不要求进白名单。 */
const TEMP_NOTE_MARKERS: readonly string[] = ['并发会话临时记录', '看板并发写入期间单独记录'];

/**
 * 是否是并发会话的临时记录（未合并前不阻塞其他会话的门禁）。
 *
 * 为什么需要：两个会话同时工作时，后写者不能把「一份待合并的临时记录」直接塞进白名单
 * （合并后删除会让白名单出现死条目），也不能因为它让另一个会话的全量测试红。用**显式标记**
 * 区分「有意的临时便签」与「随手堆在 docs/ 根的报告」——后者仍然红。
 * @param name docs 根下的文件名。
 * @returns 含标记时为 true。
 */
function isConcurrentScratchNote(name: string): boolean {
  try {
    const head = readFileSync(join(DOCS, name), 'utf8').split('\n').slice(0, 5).join('\n');
    return TEMP_NOTE_MARKERS.some((marker) => head.includes(marker));
  } catch {
    return false;
  }
}

test('① docs/ 根只允许白名单内的文档（新增根级文档必须显式决定去向）', () => {
  const actual = markdownUnder(DOCS).filter((rel) => !rel.includes('/'));
  const unexpected = actual.filter(
    (name) => !ROOT_ALLOWLIST.includes(name) && !isConcurrentScratchNote(name),
  );
  assert.deepStrictEqual(
    unexpected,
    [],
    `docs/ 根出现未登记文档：${unexpected.join('、')}\n` +
      '若它是历史审计/计划/调研 ⇒ 直接删除（本仓不再维护历史存档）；' +
      '若确为现行文档 ⇒ 加进本判据的白名单并在 docs/README.md 登记；' +
      '若只是并发会话的临时记录 ⇒ 前 5 行写明「并发会话临时记录」并在合并后删除。',
  );
  // 白名单里的每一项都必须真的存在（否则白名单本身在撒谎）。
  const missing = ROOT_ALLOWLIST.filter((name) => !existsSync(join(DOCS, name)));
  assert.deepStrictEqual(missing, [], `白名单列了不存在的文档：${missing.join('、')}`);
});

test('④ 现行索引自洽：docs/README.md 与 llms.txt 的文档链接必须指向真实文件', () => {
  for (const rel of ['README.md', 'llms.txt']) {
    const text = readFileSync(join(DOCS, rel), 'utf8');
    const broken: string[] = [];
    for (const target of localDocLinks(text)) {
      if (!target.endsWith('.md') && !target.endsWith('/')) continue;
      const abs = join(DOCS, target.replace(/\/$/, ''));
      if (target.endsWith('/')) {
        if (!existsSync(abs)) broken.push(target);
        continue;
      }
      if (!existsSync(abs)) broken.push(target);
    }
    assert.deepStrictEqual(
      broken,
      [],
      `docs/${rel} 里的链接指向不存在的文件（索引在把读者推向历史材料/已删文件）：${broken.join('、')}`,
    );
  }
});
