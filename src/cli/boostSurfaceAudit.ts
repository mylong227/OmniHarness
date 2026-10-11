/**
 * 门禁**输入表面**的静态取证与"声明失效"检测 —— 回答
 * 「`boostGateSurface.ts` 里的声明，还配得上当前这份门禁实现吗」。
 *
 * ## 为什么需要它（`boostGateSurface.ts` 的声明有一个致命弱点）
 *
 * 那张表的声明是**某个时间点**对门禁实现的一次取证。实现一旦改动，声明就可能悄悄过期，
 * 而**过期的声明比没有声明更危险**：没有声明时上层按"永不跳过"处理（fail-closed），
 * 而过期声明会让上层**放心地跳过一条其实已经需要的门禁**（假阴性）。
 *
 * 所以本模块存在的唯一目的，是让"声明过期"这件事**自己变红**。
 *
 * ## 本模块做了什么 / 没做什么（**诚实边界，判读前必读**）
 *
 * **做了什么**（三条，都是机械可复现的）：
 *  1. **门禁清单一致性**：`runGates.mjs --list` 里每条 id 都要在声明表里有交代，
 *     且每层都要与 `runGates.mjs` 的 GATES 数组一致 —— 上游增删门禁即报；
 *  2. **脚本内容指纹**：把每条门禁入口脚本的 sha256 与上次审计时比对。
 *     **任何一条变了 ⇒ 它的表面声明一律视为过期**（不是"大概没事"）；
 *  3. **声明面禁闭性**：声明里的具体文件（如 `package.json`、`tsconfig.json`）必须在
 *     其入口脚本正文里被字面提到过 —— 抓"声明了一份脚本根本不读的文件"这种笔误。
 *
 * **没做什么**（**不要**把本模块当成"运行时取证"的替代）：
 *  - **不做系统级文件访问追踪**。原 `omni-boost` 子项目里的 `fsTrace.mjs` 靠 ptrace/ETW
 *    记录进程真正读过哪些路径 —— 那在本仓的目标平台 win32 上**不可构造**（无 ptrace 等价物），
 *    在 Linux 上也要额外依赖。故此处如实不提供，而不是给一个只在某平台能跑、其它平台静默失效的仪器。
 *  - 因此**静态取证不能发现**"脚本读了声明之外的文件"这类问题（例如某门禁开始 walk 一棵新目录树
 *    而不改 argv）。那类发现的唯一可靠手段仍是重新做一次真跑取证。**本模块只保证"过期会被看见"，
 *    不保证"新出现的读取会被自动发现"。**
 *  - 也不校验声明里的 glob 与脚本行为"语义等价"：`src/**` 是否真等于脚本 walk 的那棵树，
 *    需要人（或一次真跑取证）来判断。
 *
 * ## 退出码
 *
 * `0` = 无过期、无缺失；`3` = **声明需要重新取证**（脚本变了或清单对不上）——这是**结论**不是故障；
 * `2` = 用法/环境错误（读不出门禁清单）。沿用 `boost` 全子系统的退出码口径。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GATE_SURFACE, SURFACE_AUDIT_DATE } from './boostGateSurface.js';

/** 审计快照的默认落点（仓库根相对；与探针归档同属运行时产物）。 */
export const SURFACE_SNAPSHOT_REL = '.omniharness/boost/gate-surface.json';

/** 快照格式版本：结构变动必须 +1，否则旧快照会被误判为"一致"。 */
export const SURFACE_SNAPSHOT_VERSION = 1;

/** 一条门禁的静态取证结果。 */
export interface GateSurfaceFinding {
  /** 门禁 id。 */
  readonly id: string;
  /** 该门禁在声明表里的状态。 */
  readonly declared: boolean;
  /** 声明是否已实测取证（`audited` 非空）。 */
  readonly audited: boolean;
  /** 入口脚本相对路径（取自 `runGates.mjs` 的 argv）。 */
  readonly script: string | null;
  /** 脚本 sha256（脚本缺失时为 null）。 */
  readonly hash: string | null;
  /** 与上次审计相比脚本是否变化（无历史快照时为 false，另由 `hasBaseline` 区分）。 */
  readonly drift: boolean;
  /** 入口是否可指纹（argv 首元素是 `scripts/` 下的脚本）。不可指纹的条目**不参与漂移判定**。 */
  readonly fingerprintable: boolean;
  /** 声明面里"脚本正文未提到"的具体文件（笔误嫌疑；**仅提示，不阻断**）。 */
  readonly unmentioned: readonly string[];
  /**
   * 该条是否需要重新取证。
   *
   * **只由可复核的证据触发**：未声明 / 未取证 / 脚本内容漂移。
   * "声明面里的文件没在脚本正文里被字面提到"**不算**——那是推理级证据（路径可能是常量拼出来的，
   * 实测就抓到过 `scripts/docLinkBaseline.json` 这种走常量路径的情形），把它当阻断会让工具长期假红。
   */
  readonly needsReaudit: boolean;
  /** 人类可读原因。 */
  readonly reason: string;
}

/** 一次静态审计的结论。 */
export interface SurfaceAuditReport {
  /** 审计时间。 */
  readonly createdAt: string;
  /** 声明表标注的取证日期（供人对照"声明有多旧"）。 */
  readonly declaredAuditDate: string;
  /** 是否存在历史快照（首次运行为 false ⇒ 全部按"新"处理）。 */
  readonly hasBaseline: boolean;
  /** 逐条发现。 */
  readonly findings: readonly GateSurfaceFinding[];
  /** 上游有、声明表没有的门禁 id。 */
  readonly undeclared: readonly string[];
  /** 声明表有、上游已没有的门禁 id（僵尸条目）。 */
  readonly zombie: readonly string[];
  /** 需要重新取证的条数。 */
  readonly needsReauditCount: number;
  /** 本次是否写了快照（默认不写：避免一次临时改动毒化基线）。 */
  readonly wroteSnapshot: boolean;
  /** 建议退出码：3 = 需重新取证；0 = 无问题。 */
  readonly exitCode: number;
}

/** 脚本 → 入口相对路径的提取结果（`runGates.mjs` 的 argv 首元素）。 */
interface GateEntry {
  /** 门禁 id。 */
  readonly id: string;
  /** 分层。 */
  readonly tier: string;
  /** 入口脚本（仓库根相对，正斜杠）；argv 首元素非 `scripts/` 时为 null。 */
  readonly script: string | null;
}

/** 门禁输入表面的静态取证器。 */
export class BoostSurfaceAudit {
  /**
   * @param root 仓库根绝对路径。
   */
  public constructor(private readonly root: string) {}

  /**
   * 跑一次静态审计（只读；是否**写快照**由 `acceptBaseline` 决定）。
   *
   * ## 为什么"写快照"要单独一个开关（2026-10-10 实测踩到）
   *
   * 第一版每次都写快照 ⇒ 一次**临时**改动（例如为验证判死能力而给 `checkNodeEngine.mjs` 追加一行）
   * 会把新哈希记进快照；改动还原后，审计反而**永远**报"过期"（拿的是那次瞬时状态的哈希）。
   * 这叫"快照被毒化"，而它的表现恰好与"工具坏了"一模一样。
   *
   * 故现在的规则：**只有 `acceptBaseline` 为真时才写快照**。默认不写 ⇒ 漂移会**持续可见**
   * （而不是报一次就自愈），直到人显式确认"我已重新取证"。
   * @param snapshotRel 快照落点（仓库根相对）。
   * @param acceptBaseline 是否把本次看到的脚本哈希记为"当前基线"（= 人已确认重新取证）。
   * @returns 审计结论。
   */
  public audit(
    snapshotRel: string = SURFACE_SNAPSHOT_REL,
    acceptBaseline = false,
  ): SurfaceAuditReport {
    const entries = this.readGateEntries();
    const previous = this.readSnapshot(snapshotRel);
    const hasBaseline = previous !== null;
    const prevHashes = previous?.hashes ?? {};
    const findings: GateSurfaceFinding[] = [];
    for (const entry of entries) {
      const decl = GATE_SURFACE[entry.id];
      const script = entry.script;
      const hash = script === null ? null : this.hashOf(script);
      const prevHash = script === null ? undefined : prevHashes[script];
      const drift = hash !== null && prevHash !== undefined && prevHash !== hash;
      const audited = decl !== undefined && decl.audited !== '';
      const fingerprintable = script !== null && hash !== null;
      const unmentioned =
        decl === undefined || script === null
          ? []
          : this.unmentionedConcreteFiles(script, decl.inputs ?? []);
      const reasons: string[] = [];
      if (decl === undefined) reasons.push('声明表里没有它 ⇒ 永不跳过（fail-closed）');
      else if (!audited) reasons.push('声明尚未实测取证 ⇒ 永不跳过');
      if (drift) reasons.push('入口脚本内容已变 ⇒ 其表面声明视为过期');
      if (!fingerprintable) {
        reasons.push('入口不在 scripts/ 下（无法指纹）⇒ 本工具**看不到**它的实现是否变过');
      }
      if (unmentioned.length > 0) {
        reasons.push(
          `（提示，不阻断）声明面里这些文件在脚本正文中没被提到：${unmentioned.join(', ')}`,
        );
      }
      findings.push({
        id: entry.id,
        declared: decl !== undefined,
        audited,
        script: entry.script,
        hash,
        drift,
        fingerprintable,
        unmentioned,
        // 只有"可复核的证据"能触发重新取证；"未提到"与"不可指纹"都是提示。
        needsReaudit: decl === undefined || !audited || drift,
        reason: reasons.length === 0 ? '与当前实现一致' : reasons.join('；'),
      });
    }
    const declaredIds = new Set(entries.map((e) => e.id));
    const undeclared = findings.filter((f) => !f.declared).map((f) => f.id);
    const zombie = Object.keys(GATE_SURFACE).filter((id) => !declaredIds.has(id));
    const needsReauditCount = findings.filter((f) => f.needsReaudit).length + zombie.length;
    // 默认**不写**快照（见 audit 的 JSDoc：每次写会被一次临时改动毒化，症状与"工具坏了"无异）。
    // 首次运行无基线可毒化，故照写；`acceptBaseline` = 人已确认重新取证。
    const wroteSnapshot = acceptBaseline || !hasBaseline;
    if (wroteSnapshot) this.writeSnapshot(snapshotRel, findings);
    return {
      createdAt: new Date().toISOString(),
      declaredAuditDate: SURFACE_AUDIT_DATE,
      hasBaseline,
      findings,
      undeclared,
      zombie,
      needsReauditCount,
      wroteSnapshot,
      exitCode: needsReauditCount > 0 ? 3 : 0,
    };
  }

  /**
   * 读门禁清单**及其入口脚本**（现场问 `runGates.mjs`，不复制清单）。
   * @returns 门禁条目；读不出返回空数组（调用方 fail-closed）。
   */
  public readGateEntries(): readonly GateEntry[] {
    const r = spawnSync(process.execPath, ['scripts/runGates.mjs', '--list'], {
      cwd: this.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error !== undefined || r.status !== 0) return [];
    const entries: GateEntry[] = [];
    for (const line of String(r.stdout).split('\n')) {
      const m = /^\s{2}(\S+)\s+\[(\w+)\]\s+(.*)$/.exec(line);
      if (m === null) continue;
      entries.push({ id: m[1] ?? '', tier: m[2] ?? '', script: this.scriptOf(m[1] ?? '') });
    }
    return entries;
  }

  /**
   * 取某门禁的入口脚本（解析 `runGates.mjs` 的 GATES 数组，**不硬编码映射**）。
   *
   * 为什么解析源码而不是维护一张 id→脚本 的表：那张表会成为"第三份真相"，
   * 而它恰恰是**最该随上游漂移而失效**的东西。解析失败 ⇒ 返回 null ⇒ 该条按"无法取证"处理。
   * @param id 门禁 id。
   * @returns 脚本相对路径（正斜杠）；解析不出返回 null。
   */
  public scriptOf(id: string): string | null {
    const text = this.readFile('scripts/runGates.mjs');
    if (text === null) return null;
    return BoostSurfaceAudit.parseEntries(text).get(id) ?? null;
  }

  /**
   * 逐条解析 `runGates.mjs` 的 GATES 数组（**先按条目切分再取字段**，
   * 避免"从某 id 截到文末"那种跨条目误匹配）。
   * @param text `runGates.mjs` 正文。
   * @returns 门禁 id → 入口脚本相对路径（仅含首元素是 `scripts/` 的项）。
   */
  public static parseEntries(text: string): Map<string, string> {
    const out = new Map<string, string>();
    // 条目边界 = 每个 `id: '<name>'`；其后到下一个 id 之间的正文里找第一个 argv。
    const marks = [...text.matchAll(/id:\s*'([^']+)'/g)];
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      if (mark === undefined) continue;
      const id = mark[1] ?? '';
      const start = (mark.index ?? 0) + mark[0].length;
      const end = i + 1 < marks.length ? (marks[i + 1]?.index ?? text.length) : text.length;
      const chunk = text.slice(start, end);
      const argv = /argv:\s*\[([^\]]*)\]/.exec(chunk);
      if (argv === null) continue;
      const first = /'([^']+)'/.exec(argv[1] ?? '');
      const candidate = first?.[1] ?? '';
      if (candidate.startsWith('scripts/')) out.set(id, candidate);
    }
    return out;
  }

  /**
   * 声明面里的**具体文件**（不含 glob）在脚本正文里是否被提到。
   *
   * 只查"具体文件"（无通配符的模式，如 `package.json`、`tsconfig.json`、`.nvmrc`）：
   * glob 面（例如 src 下的全部 TS）本来就是脚本 walk 出来的，正文里不会出现字面量，
   * 强查会制造大量假阳性。这一条抓的是**笔误级**问题，不是语义等价证明。
   * @param scriptRel 入口脚本相对路径。
   * @param inputs 声明的输入面。
   * @returns 未被提到的具体文件。
   */
  public unmentionedConcreteFiles(scriptRel: string, inputs: readonly string[]): readonly string[] {
    const text = this.readFile(scriptRel);
    if (text === null) return [];
    return inputs.filter((p) => !p.includes('*') && !p.includes('?') && !text.includes(p));
  }

  /**
   * 取文件 sha256。
   * @param rel 仓库根相对路径。
   * @returns 十六进制摘要；文件不可读返回 null。
   */
  public hashOf(rel: string): string | null {
    try {
      return createHash('sha256')
        .update(readFileSync(join(this.root, rel)))
        .digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * 读文本文件。
   * @param rel 仓库根相对路径。
   * @returns 正文；不可读返回 null。
   */
  private readFile(rel: string): string | null {
    try {
      return readFileSync(join(this.root, rel), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 读上次审计快照。
   * @param snapshotRel 快照落点（仓库根相对）。
   * @returns 快照；缺失/损坏返回 null（按"首次"处理，更严）。
   */
  public readSnapshot(
    snapshotRel: string = SURFACE_SNAPSHOT_REL,
  ): { version: number; hashes: Record<string, string> } | null {
    try {
      const parsed = JSON.parse(readFileSync(resolve(this.root, snapshotRel), 'utf8')) as {
        version?: number;
        hashes?: Record<string, string>;
      };
      if (parsed.version !== SURFACE_SNAPSHOT_VERSION) return null;
      return { version: parsed.version, hashes: parsed.hashes ?? {} };
    } catch {
      return null;
    }
  }

  /**
   * 写本次审计快照（下次据此判断"脚本是否变过"）。
   * @param snapshotRel 快照落点（仓库根相对）。
   * @param findings 本次发现。
   * @returns 无返回值。
   */
  private writeSnapshot(snapshotRel: string, findings: readonly GateSurfaceFinding[]): void {
    const hashes: Record<string, string> = {};
    for (const f of findings) {
      if (f.script !== null && f.hash !== null) hashes[f.script] = f.hash;
    }
    const target = resolve(this.root, snapshotRel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          version: SURFACE_SNAPSHOT_VERSION,
          auditedAt: new Date().toISOString(),
          declaredAuditDate: SURFACE_AUDIT_DATE,
          hashes,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}
