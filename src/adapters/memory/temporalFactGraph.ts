import type { MemoryFact } from '../../ports/memory/longTermMemory.ts';

/**
 * @beta
 * 记忆时间图的事实卡：一条 `subject-predicate-object` 三元组 + 时间有效区间 + 信任标注。
 *
 * 一条 `MemoryFact` 至多对应一张卡：从 `fact.text` 用**确定性规则**抽出三元组，抽不出就不建卡。
 * 语义边界（别读成「语义图谱」）：这是规则抽取，**不是 LLM 语义解析**——同义改写、代词回指、
 * 中文关系句（「项目使用 pnpm」）都抽不出来；抽不出时**静默跳过**、不产生边，
 * 因而不会污染召回（无图命中时仍走原 BM25 路径）。
 */
export interface TemporalFactCard {
  /** 来源事实 id（`MemoryFact.id`）。 */
  readonly factId: string;
  /** 归一化主语（小写、去冠词/标点、折叠空白）。 */
  readonly subject: string;
  /** 归一化谓词（`is` / `use` / `require` / `prefer` / `own` / `->`）。 */
  readonly predicate: string;
  /** 归一化宾语。 */
  readonly object: string;
  /** 原始事实文本（诊断用；召回打分只看 s/p/o）。 */
  readonly text: string;
  /** 生效时刻（毫秒）：取事实 `createdAt`；解析失败时取 ingest 的当前时刻。 */
  readonly validFrom: number;
  /**
   * 失效时刻（毫秒）：被**同主语 + 同谓词**的新事实取代时置为新事实的 `validFrom`；
   * `undefined` ＝ 仍有效（未被取代）。
   */
  readonly validTo: number | undefined;
  /** 信任标注（`MemoryFact.trust` 缺省按 `trusted`）。 */
  readonly trust: 'trusted' | 'untrusted';
  /** 事实自身失效时刻（毫秒）：由 `expiresAt` 解析；`undefined` ＝ 不过期。 */
  readonly expiresAt: number | undefined;
}

/** 一条图召回命中：命中事实 id、图得分（0..1）与事实卡。 */
export interface TemporalFactHit {
  /** 命中事实 id。 */
  readonly factId: string;
  /** 图得分：query token 与 s/p/o 的加权重合度（0..1，确定性公式）。 */
  readonly score: number;
  /** 命中事实的卡（含时间有效性，供调用方诊断）。 */
  readonly card: TemporalFactCard;
}

/** 巩固选项。 */
export interface TemporalConsolidateOptions {
  /**
   * 是否保留已关闭/过期边（默认 `false` ＝ 剪除）。
   *
   * 默认剪除的理由：图是**派生索引**（事实仍完整留在 `FileLongTermMemory` 的 JSONL 里），
   * 保留关闭边只会让索引膨胀；显式 `true` 时保留以供审计（仍不参与召回）。
   */
  readonly keepClosed?: boolean | undefined;
}

/** 一次巩固的统计（全部为边口径，不涉及事实删除）。 */
export interface TemporalConsolidationReport {
  /** 巩固前的边数。 */
  readonly before: number;
  /** 巩固后的边数（剪除模式下会变小）。 */
  readonly after: number;
  /** 被折叠的同 s+p+o 重复边数（组内非保留边；含此前已被取代关闭者，统计口径是「冗余边」）。 */
  readonly merged: number;
  /** 因 `expiresAt` 到点而关闭的边数。 */
  readonly expired: number;
  /** 已关闭/过期而被剪除的边数（`keepClosed: true` 时为 0）。 */
  readonly pruned: number;
  /** 巩固后仍可召回的活跃边数。 */
  readonly active: number;
}

/**
 * 抽取候选：某个算子在文本中的位置、长度、优先级与归一化谓词。
 *
 * 为什么需要「优先级」：同一段文本可能同时含冒号与系动词（`Note: the config is at path`），
 * 取**出现位置最靠前**的算子作为主分割；位置相同时按固定优先级裁决（箭头 > 动词 > 系动词 > 冒号）。
 */
interface TripleCandidate {
  /** 算子在文本中的起始下标。 */
  readonly operatorIndex: number;
  /** 算子长度（用于切出宾语）。 */
  readonly operatorLength: number;
  /** 同位置时的裁决优先级（越小越优先）。 */
  readonly priority: number;
  /** 归一化后的谓词。 */
  readonly predicate: string;
}

/** 抽取结果（已归一化的三元组）。 */
interface ExtractedTriple {
  /** 归一化主语。 */
  readonly subject: string;
  /** 归一化谓词。 */
  readonly predicate: string;
  /** 归一化宾语。 */
  readonly object: string;
}

/**
 * @beta
 * 记忆时间图（P2-1）：把长期记忆事实投影成「事实卡」有向图，提供**时间有效性召回**与**巩固**。
 *
 * ## 抽取规则（确定性，无模型、无第三方依赖）
 *
 * 依次识别（同一文本取**最靠前**的算子；同位置按箭头 > 动词 > 系动词 > 冒号的优先级）：
 * 1. `X -> Y`（也认 `→`）⇒ 谓词 `->`；
 * 2. `X uses/requires/prefers/owns Y`（也认第三人称与动词原形）⇒ 谓词 `use/require/prefer/own`；
 * 3. `X is/are/was/were Y` ⇒ 谓词 `is`（时态统一归并为 `is`，使「同一主谓的时态改写」能正确结代）；
 * 4. `X: Y`（也认全角 `：`）⇒ 谓词 `is`。
 *
 * 主语/宾语归一化：小写、标点/符号替换为空白、去英文冠词（the/a/an）、折叠多余空白。
 * 归一化后任一侧为空、或两侧相同 ⇒ **不建边**（无法解析不产生边，不猜）。
 *
 * ## 时间有效性（有效区间）
 *
 * - `validFrom` 取事实 `createdAt`（解析失败时用 ingest 时刻）——**不用墙钟**，这样
 *   「进程重启后从 facts 重建」与「增量 ingest」得到同一张图（可复现，`CODE_STANDARD` §12.1-5）。
 * - 同一 `subject + predicate` 的**新**事实把**旧**边（`validFrom` 不晚于新事实者）的
 *   `validTo` 置为新事实的 `validFrom`；`validTo <= now` 的边不再参与召回。
 * - `expiresAt` 到点的事实同样不再参与召回（与 `TimeDecay.isExpired` 的 `<=` 口径一致）。
 * - 召回过滤只看 `validTo` / `expiresAt`；`validFrom` 仅用于**时间定位与取代裁决**，不做
 *   「未来事实」裁剪（注入了早于事实 `createdAt` 的时钟时，不应让整批事实凭空消失）。
 *
 * ## 已知边界（如实登记，别当成语义图）
 *
 * - 只认上面四条**英文/符号**模式；中文关系句（「项目使用 pnpm」「用户偏好暗色主题」）抽不出，
 *   于是中文事实通常没有事实卡——这是有意的失败方向：宁可没有图命中走原 BM25，也不乱连边。
 * - 同一 subject+predicate 视为**单值**：`user prefers dark` 与 `user prefers vim` 会互相取代
 *   （多值谓词需要模型判定，规则层不臆断）。
 * - `update` 改写事实文本后按该事实的 `createdAt` 重新定位时间（而非编辑墙钟），以保持重建可复现。
 * - `delete` 只摘除该事实的卡；它曾取代的旧边不会因此复活（图是派生索引，不承载历史回滚）。
 */
export class TemporalFactGraph {
  /** 事实 id → 事实卡（Map 插入序即 ingest 序，巩固的同刻裁决依赖它保持确定性）。 */
  private readonly byFact = new Map<string, TemporalFactCard>();

  /**
   * 写入/更新一条事实的卡（幂等：同一 `factId` 先摘旧卡再重算）。
   *
   * 抽不出三元组时不建边（若该事实此前有卡，旧卡仍会被摘除——文本已不可解析，旧边不再成立）。
   * @param fact 记忆事实（`text` 用于抽三元组，`createdAt`/`expiresAt` 用于定时间）。
   * @param nowMs 当前时刻（毫秒）：仅当 `createdAt` 无法解析时作为 `validFrom` 的回退。
   * @returns 无返回值。
   */
  public ingest(fact: MemoryFact, nowMs: number = Date.now()): void {
    this.byFact.delete(fact.id);
    const triple = TemporalFactGraph.extractTriple(fact.text);
    if (triple === undefined) {
      return;
    }
    const validFrom = TemporalFactGraph.epochOf(fact.createdAt) ?? nowMs;
    const card: TemporalFactCard = {
      factId: fact.id,
      subject: triple.subject,
      predicate: triple.predicate,
      object: triple.object,
      text: fact.text,
      validFrom,
      validTo: undefined,
      trust: fact.trust === 'untrusted' ? 'untrusted' : 'trusted',
      expiresAt: TemporalFactGraph.epochOf(fact.expiresAt),
    };
    this.closeSuperseded(card);
    this.byFact.set(fact.id, card);
  }

  /**
   * 从全量事实重建图（进程重启 / 外部重载后的唯一恢复入口）。
   *
   * 按事实数组顺序逐条 ingest；因 `validFrom` 由每条事实的 `createdAt` 决定，
   * 重建结果与「同样的写入顺序做增量 ingest」一致（不依赖墙钟）。
   * @param facts 全量事实（顺序即持久化顺序）。
   * @param nowMs 当前时刻（毫秒）：仅作非法 `createdAt` 的回退。
   * @returns 无返回值。
   */
  public rebuild(facts: readonly MemoryFact[], nowMs: number = Date.now()): void {
    this.byFact.clear();
    for (const fact of facts) {
      this.ingest(fact, nowMs);
    }
  }

  /**
   * 摘除一条事实的卡。
   * @param factId 事实 id。
   * @returns 确实摘除了卡返回 true；该事实本来没有卡返回 false。
   */
  public remove(factId: string): boolean {
    return this.byFact.delete(factId);
  }

  /**
   * 按查询 token 与 s/p/o 的重合度召回**当前有效**的边。
   *
   * 打分（确定性，0..1）：`0.4 × 主语重合 + 0.3 × 谓词重合 + 0.3 × 宾语重合`，
   * 其中「重合」用 Dice 系数 `2|Q∩E| / (|Q|+|E|)`（`Q` 为查询 token 集，`E` 为该槽位 token 集）。
   * 过滤：`validTo <= now` 或 `expiresAt <= now` 的卡不参与召回。
   * @param query 自然语言查询（空串或纯标点返回空数组）。
   * @param nowMs 当前时刻（毫秒）。
   * @returns 命中列表：图得分降序；同分按 `factId` 字典序（确定性）。
   */
  public recall(query: string, nowMs: number): readonly TemporalFactHit[] {
    const queryTokens = new Set(TemporalFactGraph.tokensOf(query));
    if (queryTokens.size === 0) {
      return [];
    }
    const hits: TemporalFactHit[] = [];
    for (const card of this.byFact.values()) {
      if (!TemporalFactGraph.isActive(card, nowMs)) {
        continue;
      }
      const score = TemporalFactGraph.scoreOf(queryTokens, card);
      if (score <= 0) {
        continue;
      }
      hits.push({ factId: card.factId, score, card });
    }
    hits.sort(
      (left, right) =>
        right.score - left.score || TemporalFactGraph.compareIds(left.factId, right.factId),
    );
    return hits;
  }

  /**
   * 巩固（P2-1）：合并同 `s+p+o` 的重复边、关闭过期边，并给出统计。
   *
   * **只动图，不动事实**：本方法不删除任何 `MemoryFact`（`FileLongTermMemory` 层同样不删）。
   * 步骤：
   * 1. `expiresAt <= now` 的边关闭（计 `expired`）；
   * 2. 同 `s+p+o` 的重复边只留最新（`validFrom` 最大；同刻取后 ingest 者），
   *    其余关闭并计 `merged`（已因 ingest 取代而关闭的历史重复边也计入，统计口径是「同三元组冗余边」）；
   * 3. 默认剪除所有已关闭/过期边（计 `pruned`；`keepClosed: true` 时保留，仍不参与召回）。
   *
   * 剪除是安全的：图是派生索引，重启后由 `rebuild` 从事实重新构建；剪除只丢弃**派生冗余**。
   * @param nowMs 当前时刻（毫秒）。
   * @param options 巩固选项（默认剪除关闭边）。
   * @returns 巩固统计（before/after/merged/expired/pruned/active）。
   */
  public consolidate(
    nowMs: number,
    options: TemporalConsolidateOptions = {},
  ): TemporalConsolidationReport {
    const before = this.byFact.size;
    let expired = 0;
    for (const card of [...this.byFact.values()]) {
      if (card.expiresAt === undefined || card.expiresAt > nowMs) {
        continue;
      }
      if (this.closeIfOpen(card, nowMs)) {
        expired += 1;
      }
    }
    let merged = 0;
    for (const group of TemporalFactGraph.duplicateGroups(this.byFact)) {
      const newest = TemporalFactGraph.newestOf(group, nowMs);
      merged += group.length - 1;
      for (const card of group) {
        if (card !== newest) {
          this.closeIfOpen(card, nowMs);
        }
      }
    }
    let pruned = 0;
    if (options.keepClosed !== true) {
      for (const [factId, card] of [...this.byFact]) {
        if (card.validTo !== undefined && card.validTo <= nowMs) {
          this.byFact.delete(factId);
          pruned += 1;
        }
      }
    }
    const active = this.activeSize(nowMs);
    return { before, after: this.byFact.size, merged, expired, pruned, active };
  }

  /**
   * 当前索引中的边数（含已关闭边；剪除后只剩活跃边）。
   * @returns 边数。
   */
  public size(): number {
    return this.byFact.size;
  }

  /**
   * 当前时刻仍可召回的活跃边数。
   * @param nowMs 当前时刻（毫秒）。
   * @returns 活跃边数。
   */
  public activeSize(nowMs: number): number {
    let active = 0;
    for (const card of this.byFact.values()) {
      if (TemporalFactGraph.isActive(card, nowMs)) {
        active += 1;
      }
    }
    return active;
  }

  /**
   * 全部事实卡快照（调试 / 管理 UI 用）。
   * @returns 事实卡数组（ingest 序）。
   */
  public cards(): readonly TemporalFactCard[] {
    return [...this.byFact.values()];
  }

  /**
   * 按事实 id 取卡。
   * @param factId 事实 id。
   * @returns 对应事实卡；不存在时为 undefined。
   */
  public cardOf(factId: string): TemporalFactCard | undefined {
    return this.byFact.get(factId);
  }

  /**
   * 关闭被新卡取代的旧边：同主语 + 同谓词、且 `validFrom` 不晚于新卡者。
   * @param next 新写入的卡。
   * @returns 无返回值。
   */
  private closeSuperseded(next: TemporalFactCard): void {
    for (const other of [...this.byFact.values()]) {
      if (other.subject !== next.subject || other.predicate !== next.predicate) {
        continue;
      }
      if (other.validTo !== undefined || other.validFrom > next.validFrom) {
        continue;
      }
      this.byFact.set(other.factId, { ...other, validTo: next.validFrom });
    }
  }

  /**
   * 若卡仍处于打开状态，则在 `atMs` 关闭它（已关闭的卡不覆盖原 `validTo`）。
   * @param card 待关闭的卡。
   * @param atMs 关闭时刻（毫秒；不早于该卡的 `validFrom`）。
   * @returns 本次确实执行了关闭返回 true；卡本就已关闭返回 false。
   */
  private closeIfOpen(card: TemporalFactCard, atMs: number): boolean {
    if (card.validTo !== undefined) {
      return false;
    }
    this.byFact.set(card.factId, {
      ...card,
      validTo: Math.max(card.validFrom, atMs),
    });
    return true;
  }

  /**
   * 把卡按 `s+p+o` 分组，只返回存在重复（≥2 条）的组（含已关闭的历史重复边）。
   * @param byFact 事实卡索引。
   * @returns 重复组列表（组内按 ingest 序）。
   */
  private static duplicateGroups(
    byFact: ReadonlyMap<string, TemporalFactCard>,
  ): readonly (readonly TemporalFactCard[])[] {
    const groups = new Map<string, TemporalFactCard[]>();
    for (const card of byFact.values()) {
      const key = `${card.subject}\u0000${card.predicate}\u0000${card.object}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [card]);
      } else {
        group.push(card);
      }
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }

  /**
   * 组内保留卡的裁决：优先活跃卡（避免「较新但已过期」的卡把仍有效的旧卡挤掉），
   * 活跃态相同时取 `validFrom` 最大者；同刻取**后** ingest 者（组内顺序即 ingest 序）。
   * @param group 同 s+p+o 的重复卡组（≥2 条）。
   * @param nowMs 当前时刻（毫秒）。
   * @returns 应保留的卡。
   */
  private static newestOf(group: readonly TemporalFactCard[], nowMs: number): TemporalFactCard {
    let kept = group[0] as TemporalFactCard;
    for (const card of group) {
      const cardActive = TemporalFactGraph.isActive(card, nowMs);
      const keptActive = TemporalFactGraph.isActive(kept, nowMs);
      if (cardActive !== keptActive) {
        if (cardActive) {
          kept = card;
        }
        continue;
      }
      if (card.validFrom >= kept.validFrom) {
        kept = card;
      }
    }
    return kept;
  }

  /**
   * 判断卡在 `nowMs` 是否有效（`validTo` 与 `expiresAt` 均采用「到点即失效」的 `<=` 口径）。
   * @param card 事实卡。
   * @param nowMs 当前时刻（毫秒）。
   * @returns 仍有效返回 true。
   */
  private static isActive(card: TemporalFactCard, nowMs: number): boolean {
    if (card.validTo !== undefined && card.validTo <= nowMs) {
      return false;
    }
    if (card.expiresAt !== undefined && card.expiresAt <= nowMs) {
      return false;
    }
    return true;
  }

  /**
   * 从事实文本抽取三元组（规则见类注释；无法解析返回 undefined）。
   * @param text 事实文本。
   * @returns 归一化三元组；无法解析时为 undefined。
   */
  private static extractTriple(text: string): ExtractedTriple | undefined {
    const candidates: TripleCandidate[] = [];
    TemporalFactGraph.collectCandidate(text, ARROW_PATTERN, 0, () => '->', candidates);
    TemporalFactGraph.collectCandidate(
      text,
      VERB_PATTERN,
      1,
      (raw) => TemporalFactGraph.canonicalVerb(raw),
      candidates,
    );
    TemporalFactGraph.collectCandidate(text, COPULA_PATTERN, 2, () => 'is', candidates);
    TemporalFactGraph.collectCandidate(text, COLON_PATTERN, 3, () => 'is', candidates);
    candidates.sort(
      (left, right) => left.operatorIndex - right.operatorIndex || left.priority - right.priority,
    );
    for (const candidate of candidates) {
      const subject = TemporalFactGraph.normalizeEntity(text.slice(0, candidate.operatorIndex));
      const object = TemporalFactGraph.normalizeEntity(
        text.slice(candidate.operatorIndex + candidate.operatorLength),
      );
      if (subject === '' || object === '' || subject === object) {
        continue;
      }
      return { subject, predicate: candidate.predicate, object };
    }
    return undefined;
  }

  /**
   * 把某个算子的**首个**出现位置收进候选表。
   * @param text 事实文本。
   * @param pattern 算子模式（不得带 `g` 旗标，避免 `lastIndex` 跨次污染）。
   * @param priority 同位置裁决优先级（越小越优先）。
   * @param predicateOf 由算子原文得到归一化谓词。
   * @param out 候选表（原地追加）。
   * @returns 无返回值。
   */
  private static collectCandidate(
    text: string,
    pattern: RegExp,
    priority: number,
    predicateOf: (raw: string) => string,
    out: TripleCandidate[],
  ): void {
    const match = pattern.exec(text);
    if (match === null) {
      return;
    }
    const raw = match[0];
    out.push({
      operatorIndex: match.index,
      operatorLength: raw.length,
      priority,
      predicate: predicateOf(raw),
    });
  }

  /**
   * 实体归一化：小写、标点/符号 → 空白、去冠词、折叠空白。
   * @param raw 原始实体片段。
   * @returns 归一化实体（可能为空串 ⇒ 调用方不建边）。
   */
  private static normalizeEntity(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .split(/\s+/u)
      .filter((word) => word !== '' && !ARTICLES.has(word))
      .join(' ');
  }

  /**
   * 谓词动词归一（`uses/use` → `use`，其余同理）。
   * @param raw 匹配到的动词原文。
   * @returns 归一化谓词（模板只匹配四个动词族，兜底为 `own`）。
   */
  private static canonicalVerb(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.startsWith('use')) {
      return 'use';
    }
    if (lower.startsWith('require')) {
      return 'require';
    }
    if (lower.startsWith('prefer')) {
      return 'prefer';
    }
    return 'own';
  }

  /**
   * 文本 → 打分 token（拉丁词含单字符、数字；CJK 单字 + 二元组）。
   *
   * 与 `Bm25Index.tokenize` 的差异（有意）：**保留单字符拉丁词**——实体名 `C` / `R` 属正常存在，
   * 而 BM25 侧丢弃 <2 字符词，图能补上这一类召回（见集成判据「BM25 漏但图命中」）。
   * @param text 待分词的文本。
   * @returns token 数组（保留重复，仅用于集合化打分）。
   */
  private static tokensOf(text: string): readonly string[] {
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    for (const match of lower.matchAll(/[\p{Script=Latin}\p{N}_]+/gu)) {
      const word = match[0];
      if (word !== undefined) {
        tokens.push(word);
      }
    }
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
    for (const match of lower.matchAll(cjk)) {
      const chars = Array.from(match[0] ?? '');
      for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        if (char === undefined) {
          continue;
        }
        tokens.push(char);
        const next = chars[index + 1];
        if (next !== undefined) {
          tokens.push(char + next);
        }
      }
    }
    return tokens;
  }

  /**
   * 查询 token 集与某槽位实体的重合度（Dice 系数）。
   * @param queryTokens 查询 token 集。
   * @param entity 归一化实体（s/p/o 之一）。
   * @returns 0..1 的重合度；任一侧无 token 时为 0。
   */
  private static overlap(queryTokens: ReadonlySet<string>, entity: string): number {
    const entityTokens = new Set(TemporalFactGraph.tokensOf(entity));
    if (queryTokens.size === 0 || entityTokens.size === 0) {
      return 0;
    }
    let shared = 0;
    for (const token of queryTokens) {
      if (entityTokens.has(token)) {
        shared += 1;
      }
    }
    return (2 * shared) / (queryTokens.size + entityTokens.size);
  }

  /**
   * 图的确定性打分：主语 0.4 + 谓词 0.3 + 宾语 0.3。
   * @param queryTokens 查询 token 集。
   * @param card 事实卡。
   * @returns 0..1 的图得分。
   */
  private static scoreOf(queryTokens: ReadonlySet<string>, card: TemporalFactCard): number {
    return (
      SUBJECT_WEIGHT * TemporalFactGraph.overlap(queryTokens, card.subject) +
      PREDICATE_WEIGHT * TemporalFactGraph.overlap(queryTokens, card.predicate) +
      OBJECT_WEIGHT * TemporalFactGraph.overlap(queryTokens, card.object)
    );
  }

  /**
   * 解析 ISO 时间为毫秒时间戳（缺省或解析失败返回 undefined）。
   * @param iso ISO 时间串（可缺省）。
   * @returns 有限毫秒时间戳；不可用时为 undefined。
   */
  private static epochOf(iso: string | undefined): number | undefined {
    if (iso === undefined) {
      return undefined;
    }
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * 事实 id 的确定性序（同分排序用；不用 `localeCompare`，避免环境 locale 影响）。
   * @param left 左 id。
   * @param right 右 id。
   * @returns 比较结果。
   */
  private static compareIds(left: string, right: string): number {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
}

/** 箭头算子（`->` / `→`）。 */
const ARROW_PATTERN = /->|→/u;
/** 冒号算子（半角 / 全角）。 */
const COLON_PATTERN = /[:：]/u;
/** 谓词动词算子（`use(s)` / `require(s)` / `prefer(s)` / `own(s)`）。 */
const VERB_PATTERN = /\b(uses?|requires?|prefers?|owns?)\b/iu;
/** 系动词算子（时态统一归一为 `is`）。 */
const COPULA_PATTERN = /\b(is|are|was|were)\b/iu;
/** 英文冠词（归一化时整词丢弃）。 */
const ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an']);
/** 主语重合度权重。 */
const SUBJECT_WEIGHT = 0.4;
/** 谓词重合度权重。 */
const PREDICATE_WEIGHT = 0.3;
/** 宾语重合度权重。 */
const OBJECT_WEIGHT = 0.3;
