/**
 * evolution 子命令（S7）：`omniharness evolution status|cycle|rollback`。
 *
 * ## 职责边界（为什么这样切）
 *
 * - **status 只读**：验签台账 + 分类计数 + 最近快照锚点。它**不**构造运行时、**不**写任何文件——
 *   「看一眼状态」绝不该有副作用（判据钉死）。
 * - **rollback 需 `--yes`**：回滚是治理动作（会把回滚事件写进台账链，并产出还原技能包）；
 *   不给 `--yes` 即拒（退出码 2，零改动）。
 * - **cycle** 需要「配置装载 + 运行时装配」能力（模型、遥测、固化器……），那是命令链
 *   （`ExecCli`）才有的东西，故本类只做**旗标与门禁**，把真正的执行经 {@link EvolutionCycleRunner}
 *   钩子委托出去（同 `PluginCommand` 注入注册表工厂的既有形态）。
 *
 * ## 回滚产物为什么是「技能包文件」
 *
 * CLI 进程里没有活着的技能表（技能表随会话进程存在）；回滚的**可交付物**因而是
 * `--skills` 能直接吃回去的还原技能包（`{ "skills": [...] }`，与 `CliSkillFlags` 同一格式）。
 * 台账链里则留下 `rollback` 条目（治理事件不隐身）。
 *
 * @maturity L1 — status 只读 / rollback 门禁与产物格式判据钉死；CLI 不持活技能表（诚实边界）
 * @maturityEvidence tests/unit/evolutionCommand.test.ts
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HashChainPromotionLedger } from '../evolution/hashChainPromotionLedger.js';
import { PromotionHistoryService } from '../governance/promotionHistoryService.js';
import type { PromotionLedgerEntry, SkillRestorePlan } from '../ports/runtime/evolution.js';
import { CliArgReader } from './cliArgReader.js';

/** 默认台账目录（与组合根同一口径：`<workspace>/.omniharness/evolution`）。 */
const DEFAULT_LEDGER_DIR = join('.omniharness', 'evolution');

/** 用法提示。 */
const USAGE =
  '用法: omniharness evolution status [--workspace DIR] [--dir REL] [--json]\n' +
  '      omniharness evolution history [--workspace DIR] [--dir REL] [--json]\n' +
  '      omniharness evolution cycle --yes [其他 CLI 旗标…]\n' +
  '      omniharness evolution rollback --seq N --yes [--out FILE] [--workspace DIR] [--dir REL]\n' +
  '说明: status 只读；cycle / rollback 会改动状态，必须显式 --yes。\n';

/**
 * cycle 执行钩子：由命令链接入（需要配置装载 + 运行时装配能力）。
 * @param request 透传给命令链的请求（原始旗标与输出格式）
 * @returns 进程退出码
 */
export type EvolutionCycleRunner = (request: {
  /** `evolution cycle` 之后的原始旗标（已剔除 `--yes`）。 */
  readonly argv: readonly string[];
  /** 是否 JSON 输出。 */
  readonly json: boolean;
}) => Promise<number>;

/** evolution 子命令：status（只读）/ cycle（会话内动作的显式入口）/ rollback（治理动作）。 */
export class EvolutionCommand {
  /**
   * @param cycleRunner cycle 执行钩子（缺省 = 未接线，如实报用法错误而非假装成功）
   */
  public constructor(private readonly cycleRunner?: EvolutionCycleRunner | undefined) {}

  /**
   * 执行 evolution 子命令。
   * @param args 子命令参数（已去掉 `evolution`，首元素为子命令名）
   * @returns 进程退出码（0 成功 / 1 台账不可用（断链等 fail-closed）/ 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    const sub = args[0];
    if (sub === 'status') return this.status(args.slice(1));
    if (sub === 'history') return this.history(args.slice(1));
    if (sub === 'rollback') return this.rollback(args.slice(1));
    if (sub === 'cycle') return this.cycle(args.slice(1));
    process.stdout.write(USAGE);
    return 2;
  }

  /**
   * status（只读）：验签台账、分类计数、给出最近快照锚点。**零写入、零运行时构造**。
   * @param args `status` 之后的旗标
   * @returns 0 = 台账完整或尚未产生；1 = 台账不可用（断链/损毁）
   */
  private status(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const json = reader.has('--json');
    const dir = this.ledgerDir(reader);
    let ledger: HashChainPromotionLedger;
    try {
      ledger = new HashChainPromotionLedger({ dir });
    } catch (err) {
      return Promise.resolve(this.reportUnusable(dir, err, json));
    }
    const report = ledger.verify();
    const entries = ledger.list();
    const summary = {
      dir,
      ok: report.ok,
      entries: report.count,
      snapshots: entries.filter((e) => e.action === 'snapshot').length,
      promotions: entries.filter((e) => e.action === 'promote').length,
      rollbacks: entries.filter((e) => e.action === 'rollback').length,
      latestSnapshotSeq: EvolutionCommand.latestSnapshotSeq(entries),
      ...(report.ok ? {} : { brokenAt: report.brokenAt, reason: report.reason }),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stdout.write(
        `进化台账：${summary.dir}\n` +
          `  验签：${report.ok ? 'ok' : `红（seq=${summary.brokenAt ?? '?'}：${summary.reason ?? ''}）`}\n` +
          `  条目：${summary.entries}（snapshot ${summary.snapshots} ｜ promote ${summary.promotions} ｜ rollback ${summary.rollbacks}）\n` +
          `  最近快照 seq：${summary.latestSnapshotSeq ?? '（无）'}\n`,
      );
    }
    return Promise.resolve(report.ok ? 0 : 1);
  }

  /**
   * history（只读，**F2 治理台数据面的 CLI 出口**）：逐行晋升史 + 每行**独立复核** + 可回滚快照锚点。
   *
   * 为什么 CLI 也要有：治理台的 Web tab 是产品面，但"每条记录能不能独立复核"是**数据面**问题——
   * 有 CLI 出口 ⇒ 运维在无浏览器环境（CI / 跳板机）也能核；Web tab 日后消费**同一个**服务。
   * @param args `history` 之后的旗标
   * @returns 0 = 每行复核通过；1 = 存在复核失败行或台账不可用
   */
  private history(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const json = reader.has('--json');
    const dir = this.ledgerDir(reader);
    let ledger: HashChainPromotionLedger;
    try {
      ledger = new HashChainPromotionLedger({ dir });
    } catch (err) {
      return Promise.resolve(this.reportUnusable(dir, err, json));
    }
    const view = new PromotionHistoryService(ledger, (entry) =>
      HashChainPromotionLedger.hashOf(entry),
    ).view();
    if (json) {
      process.stdout.write(`${JSON.stringify({ dir, ...view })}\n`);
    } else {
      process.stdout.write(
        `晋升史：${dir}（共 ${String(view.summary.total)} 条，独立复核通过 ${String(view.summary.verified)} 条）\n`,
      );
      for (const row of view.rows) {
        const who =
          row.name === undefined
            ? ''
            : ` ${row.name}${row.source === undefined ? '' : ` ← ${row.source}`}`;
        const flag = row.verified ? '✓' : `✗（${row.reason ?? '复核失败'}）`;
        process.stdout.write(`  #${String(row.seq)} ${row.action}${who} ${flag}\n`);
      }
      process.stdout.write(
        `可回滚快照：${
          view.rollbackTargets.length === 0
            ? '（无）'
            : view.rollbackTargets
                .map((t) => `#${String(t.seq)}(${String(t.skillCount)} 技能)`)
                .join(' ｜ ')
        }\n`,
      );
    }
    const allVerified = view.summary.verified === view.summary.total;
    return Promise.resolve(allVerified ? 0 : 1);
  }

  /**
   * cycle（写操作）：门禁 `--yes` + 委托钩子执行。
   * @param args `cycle` 之后的旗标
   * @returns 钩子退出码；缺 `--yes` 或未接线时为 2（用法错误，零改动）
   */
  private async cycle(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const json = reader.has('--json');
    if (!reader.has('--yes')) {
      process.stderr.write(
        'evolution cycle 会改动状态（台账写入 + 技能表晋升），必须显式加 --yes。\n',
      );
      return 2;
    }
    if (this.cycleRunner === undefined) {
      process.stderr.write('evolution cycle 未接线（缺少运行时装配钩子）。\n');
      process.stdout.write(USAGE);
      return 2;
    }
    return this.cycleRunner({ argv: args.filter((a) => a !== '--yes'), json });
  }

  /**
   * rollback（写操作）：门禁 `--yes` → 台账验签 → `rollback(seq)` → 产出还原技能包。
   * @param args `rollback` 之后的旗标
   * @returns 0 成功；1 台账不可用（断链/seq 非法，fail-closed）；2 用法错误
   */
  private rollback(args: readonly string[]): Promise<number> {
    const reader = new CliArgReader(args);
    const seqRaw = reader.value('--seq');
    if (seqRaw === undefined) {
      process.stdout.write(USAGE);
      return Promise.resolve(2);
    }
    const seq = Number.parseInt(seqRaw, 10);
    if (!Number.isFinite(seq) || seq <= 0) {
      process.stderr.write(`--seq 必须是正整数（实际：${seqRaw}）\n`);
      return Promise.resolve(2);
    }
    if (!reader.has('--yes')) {
      process.stderr.write(
        `evolution rollback --seq ${seq} 会把回滚事件写进台账并产出还原技能包，必须显式加 --yes。\n`,
      );
      return Promise.resolve(2);
    }
    const json = reader.has('--json');
    const dir = this.ledgerDir(reader);
    const ledger = new HashChainPromotionLedger({ dir });
    if (!ledger.verify().ok) {
      process.stderr.write('台账链不完整（断链/被篡改）：fail-closed 拒绝回滚。\n');
      return Promise.resolve(1);
    }
    const plan = EvolutionCommand.restorePlanOf(ledger, seq);
    if (plan === undefined) {
      return Promise.resolve(1);
    }
    const out = resolve(reader.value('--out') ?? join(dir, `rollback-${plan.seq}.skills.json`));
    writeFileSync(out, `${JSON.stringify({ skills: plan.skills }, null, 2)}\n`, 'utf8');
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ seq: plan.seq, restored: plan.skills.length, out })}\n`,
      );
    } else {
      process.stdout.write(
        `已回滚到快照 seq=${plan.seq}：还原 ${plan.skills.length} 条技能 → ${out}\n` +
          '  用 `omniharness --skills ' +
          out +
          ' …` 把它接回下一次会话。\n',
      );
    }
    return Promise.resolve(0);
  }

  /**
   * 产出还原计划（seq 非法时如实报错，绝不静默空还原）。
   * @param ledger 已验签的台账
   * @param seq 目标快照 seq
   * @returns 还原计划；定位不到快照时为 undefined（错误已写 stderr）
   */
  private static restorePlanOf(
    ledger: HashChainPromotionLedger,
    seq: number,
  ): SkillRestorePlan | undefined {
    try {
      return ledger.rollback(seq);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return undefined;
    }
  }

  /**
   * 台账目录解析：`--dir`（工作区内相对路径）优先，其次默认 `.omniharness/evolution`。
   * @param reader 参数读取器
   * @returns 绝对目录路径
   */
  private ledgerDir(reader: CliArgReader): string {
    const workspace = resolve(reader.value('--workspace') ?? process.cwd());
    return resolve(workspace, reader.value('--dir') ?? DEFAULT_LEDGER_DIR);
  }

  /**
   * 台账不可用时的如实申报（fail-closed：不当成功）。
   * @param dir 台账目录
   * @param err 构造期异常
   * @param json 是否 JSON 输出
   * @returns 退出码 1
   */
  private reportUnusable(dir: string, err: unknown, json: boolean): number {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(`${JSON.stringify({ dir, ok: false, reason: message })}\n`);
    } else {
      process.stderr.write(`台账不可用（${dir}）：${message}\n`);
    }
    return 1;
  }

  /**
   * 最近一次快照的 seq（回滚锚点提示）。
   * @param entries 台账条目
   * @returns 最近 snapshot 的 seq；无快照为 undefined
   */
  private static latestSnapshotSeq(entries: readonly PromotionLedgerEntry[]): number | undefined {
    let latest: number | undefined;
    for (const entry of entries) {
      if (entry.action === 'snapshot') latest = entry.seq;
    }
    return latest;
  }
}
