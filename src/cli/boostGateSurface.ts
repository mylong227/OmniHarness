/**
 * 门禁**判定输入表面**（回答「这条门禁的结论取决于仓库里哪些路径」）。
 *
 * ## 这张表的地位（**读之前先接受这一条**）
 *
 * 本文件是 `boost` 子系统里**唯一**允许"声明"而非"现场读取"的东西，因此它必须自带证伪手段：
 * 每条声明的 `audited` 字段记录了**最后一次实测取证**的时间与结论。未经取证的声明，
 * 上层一律按"**永不跳过**"处理（fail-closed）——因为**一个没核对的声明只是另一个人的推理**。
 *
 * ## 为什么不能用"读代码推理"代替取证（实测抓到的反例，全部是"看代码觉得是 A，实测是 B"）
 *
 *  1. `auditStandards.mjs --maturity` 看似只扫 `src/**`，实际还会顺着源码里的
 *     `@maturityEvidence <路径>` 去读 `tests/**` 的证据文件 ⇒ 只按 `src/**` 声明就会**漏判**。
 *  2. ESLint v9 走 `fs.promises.readFile`（**promise 版**）。取证器第一版只补了同步族，
 *     于是把 `eslint` 的表面记成"空"——**假阴性**。假阴性比假阳性危险得多：它会让人放心地跳过一条门禁。
 *  3. `tsc` 与 `eslint-typed` 实测读取**完全相同**（含 `tests/**`、`examples/**`）。
 *     `eslint-typed` 的 argv 只写 `eslint src`，看着很窄；但类型感知 lint 会加载整个 TS program，
 *     于是 `tsconfig.json` 的三棵树都进了它的表面。
 *  4. **取证器自己也会假阴性**：第一版只把 `readFileSync` 认作"读了内容"，promise 族被静默丢掉。
 *     **教训：一个不报错的假阴性，比一个报错的假阳性危险得多。**
 *
 * ## 匹配语义
 *
 * 路径级判定：改动集里有**任一**路径落在某门禁的 `inputs` 内 ⇒ 该门禁必须跑。
 * 这对"新增/删除文件"同样成立——`src/**` 命中 `src/new.ts`，故新增 `.ts` 必然触发，
 * 不存在"文件还不存在所以不算改动"的漏洞。
 *
 * ## 诚实边界
 *
 * - `residual` 是**必须保留**的字段：声明面之外仍可能影响结论的已知残余。删掉它等于假装表面是完备的。
 * - 本表的取证是在**本机、某一天**做的。门禁脚本改动后必须重新取证（`boost` 的规则：脚本内容变了，
 *   表面声明即失效——见 `boostCommand.ts` 的快照核对）。
 * - 本表**不是**门禁清单：id 的存在与否由 `scripts/runGates.mjs --list` 现场决定；
 *   本表只声明"给定这个 id，它的输入面是什么"。上游新增门禁 ⇒ 本表查不到 ⇒ 永不跳过。
 */

/** 取证日期（同一批声明在同一天实测核对）。 */
export const SURFACE_AUDIT_DATE = '2026-10-09';

/** 一条门禁的判定输入表面声明。 */
export interface BoostGateSurface {
  /** **判定输入**：改动集碰到任一 glob ⇒ 该门禁必须跑。空/缺省 ⇒ 永不跳过。 */
  readonly inputs?: readonly string[];
  /** 该门禁会**遍历**的目录根（用于识别"枚举面漂移"）；空串 = 仓库根。 */
  readonly enumRoots: readonly string[];
  /** 为什么是这些路径（`--explain` 打印；须能被取证复核）。 */
  readonly why: string;
  /** 最后一次实测核对的时间与结论；空串 = **尚未取证** ⇒ 永不跳过。 */
  readonly audited: string;
  /** 声明面**之外**仍可能影响结论的已知残余（诚实边界，不得省略）。 */
  readonly residual: string;
}

/**
 * 门禁 id → 判定输入表面。
 *
 * 键必须覆盖 `scripts/runGates.mjs --list` 的全部 id：`tests/unit/boostCommand.test.ts`
 * 有一条判据现场读清单并比对，漏一条即红（这正是"上游新增门禁"能被立刻发现的原因）。
 */
export const GATE_SURFACE: Readonly<Record<string, BoostGateSurface>> = {
  'node-engine': {
    inputs: ['package.json', '.nvmrc'],
    enumRoots: [],
    why: '只读 package.json 的 engines.node 与 process.version 比较；.nvmrc 由报错提示引用，一并纳入以免改动它后提示与事实不符',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = package.json（1 条），在声明面内`,
    residual:
      'Node **运行时版本**变化也会翻转结论，但那不是仓库文件的改动，增量判定无从覆盖——全量核验时自然重跑。',
  },
  'iron-law': {
    inputs: [
      'src/**/*.ts',
      'package.json',
      'dependency-allowlist.json',
      'scripts/checkFuncBaseline.json',
    ],
    enumRoots: ['src'],
    why: 'walk(src) 后逐文件度量，另读依赖白名单与函数基线',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 依赖白名单 + package.json + 函数基线 + 1038 个 src/**/*.ts（共 1041 条），在声明面内`,
    residual:
      '会统计 node_modules 体积与"已安装但未使用"的依赖；那些路径由 lockfile 决定，而 lockfile 已在源码/配置面整体判为全量。',
  },
  maturity: {
    inputs: ['src/**/*.ts', 'tests/**'],
    enumRoots: ['src'],
    why: 'walk(src) 找 @maturity 声明；L2/L3 的证据路径会被**读取并判定**',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1114 条，锚点为 src/**/*.ts + tests/**。**这里是推理差点漏掉的地方**`,
    residual:
      '证据路径若非 tests/**，其 existsSync 结果不改变最终结论（该声明必然因"非测试文件"判红），故不必纳入表面。',
  },
  'standard-delta': {
    inputs: ['**/*.ts', '**/*.tsx'],
    enumRoots: ['src'],
    why: '取暂存区的 .ts 改动，再比对暂存版与 HEAD 版的标准度量；report 构建在该分支之前，故 src/**/*.ts 每次都会被读',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1038 个 src/**/*.ts，在声明面内（声明取 **/*.ts 为超集）`,
    residual: '**只认暂存区**：worktree 模式下未暂存的 .ts 改动它看不见——这是上游门禁的既有语义。',
  },
  arch: {
    inputs: ['src/**/*.ts'],
    enumRoots: ['src'],
    why: '只 walk(src) 且只收非 .d.ts 的 .ts，五条规则全在该集合上判定',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1038 个 src/**/*.ts，在声明面内`,
    residual: '',
  },
  wiring: {
    inputs: ['src/**/*.ts', 'package.json'],
    enumRoots: ['src'],
    why: 'walk(src) 收集声明/装配/消费点，另读 package.json',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = package.json + 1038 个 src/**/*.ts（共 1039 条），在声明面内`,
    residual: '',
  },
  'doc-links': {
    inputs: ['README.md', 'docs/**', 'scripts/docLinkBaseline.json'],
    enumRoots: ['docs'],
    why: '输入固定为仓库根 README.md + docs/**（排除 archive），另读死链基线',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = README.md + 40 份 docs/**/*.md + 死链基线，在声明面内`,
    residual: '**不扫 docs/ 之外的 markdown**：根目录以外的散落 .md 若有死链，本门禁看不见。',
  },
  secrets: {
    inputs: ['**'],
    enumRoots: [],
    why: '用 `git diff --cached --name-only` 列暂存文件、再逐条 `git grep --cached` 扫内容 ⇒ **任何被暂存的文件都在判定面内**',
    audited: `${SURFACE_AUDIT_DATE}：实测**零 fs 读取**，全部经子进程完成（git diff / git grep）⇒ 按"全路径"声明`,
    residual:
      '这是唯一**粒度不可收窄**的门禁：它的输入是"本次提交的全部内容"。因此任何改动下它都会被选中——这正是它该扮演的角色，不是"兜底"。',
  },
  'top-level-fn': {
    inputs: ['src/**/*.ts'],
    enumRoots: ['src'],
    why: '先取全部已跟踪文件，再只对 src/** 的非 .d.ts 做 AST 判定',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1038 个 src/**/*.ts（另有子进程 git ls-files），在声明面内`,
    residual: '`git ls-files` 会枚举全部已跟踪路径，但结果只经 src/** + .ts 过滤后进入判定。',
  },
  eslint: {
    inputs: ['**/*.ts', '**/*.tsx', '**/*.js'],
    enumRoots: [''],
    why: '`eslint .`；配置的 ignores 含 `**/*.mjs` / `**/*.cjs`，故判定面 = 全仓 .ts/.tsx/.js',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 1779 条 = src/tests/web/examples/docs 五棵树，与 eslint 自报的"被检查文件数"逐一对上。**声明面比"只有 .ts"宽**：.js 也在内`,
    residual:
      'eslint 的配置面（`eslint.config.mjs` 等）在上层按"配置面 ⇒ 全量"处理。`third-party/**`、`target/**` 已被 ignores 排除。',
  },
  tsc: {
    inputs: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts', 'tsconfig.json', 'package.json'],
    enumRoots: ['src', 'tests', 'examples'],
    why: 'tsconfig.json 的 include 只有 src/**、tests/**、examples/** 三棵树；类型检查还会读依赖面',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1557 条，锚点为三棵树 + tsconfig.json + package.json`,
    residual:
      '**`web/**` 不在 include 内**（前端由 `web/tsconfig.json` 单独构建）⇒ 改 `web/**.ts` 不触发本门禁。这是上游现状，本表如实登记而不"补一刀"。',
  },
  'eslint-typed': {
    inputs: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts', 'tsconfig.json', 'package.json'],
    enumRoots: ['src', 'tests', 'examples'],
    why: 'argv 是 `eslint src --config eslint.typed.config.mjs`，但类型感知 lint 会**加载整个 TS program** ⇒ 判定面等于 tsconfig 的三棵树',
    audited: `${SURFACE_AUDIT_DATE}：实测强读取 = 1557 条，与 tsc **逐条一致**。这正是否掉"argv 只写 src 所以表面只有 src"这条推理的证据`,
    residual: '',
  },
};

/** 模式 → 正则的缓存（同一模式在一轮判定里会被问上千次）。 */
const REGEXP_CACHE = new Map<string, RegExp>();
/**
 * 门禁表面判定的**实现类**（`export class` 是本仓对非 UI `.ts` 的硬要求：
 * 顶层 `function` 声明会被 `auditTopLevelFunctions.mjs` 判红）。
 */
export class BoostGateSurface {
  /**
   * glob → 锚定正则。只支持本表用到的四种语法，刻意保持小：
   * `**` + `/`（任意层目录）、`**`（任意字符）、`*`（不含 `/` 的一段）、`?`（单个非 `/` 字符）。
   * @param pattern glob 模式（正斜杠）。
   * @returns 锚定正则。
   */
  public static globToRegExp(pattern: string): RegExp {
    const cached = REGEXP_CACHE.get(pattern);
    if (cached !== undefined) return cached;
    let out = '^';
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i] ?? '';
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          if (pattern[i + 2] === '/') {
            // `**/` 吞掉"零层或多层目录"，故 `src/**/*.ts` 能匹配 `src/a.ts`。
            out += '(?:.*/)?';
            i += 2;
          } else {
            out += '.*';
            i += 1;
          }
        } else {
          out += '[^/]*';
        }
        continue;
      }
      if (c === '?') {
        out += '[^/]';
        continue;
      }
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const re = new RegExp(`${out}$`);
    REGEXP_CACHE.set(pattern, re);
    return re;
  }

  /**
   * 某仓库相对路径是否落在某个 glob 面内。
   * @param pattern glob（正斜杠）。
   * @param relPath 仓库相对路径（正斜杠，不带前导 `./`）。
   * @returns 是否命中。
   */
  public static matches(pattern: string, relPath: string): boolean {
    return BoostGateSurface.globToRegExp(pattern).test(relPath);
  }

  /**
   * 该门禁能否因为"本次改动没碰它的输入"而不跑（**两道 fail-closed 闸门**）。
   *
   * 没有声明、或声明未经实测核对（`audited === ''`），都不许跳过：未核对的声明只是另一个人的推理，
   * 而本文件的教训正是推理会错。
   * @param gateId 门禁 id。
   * @returns 可跳过性与理由。
   */
  public static skippabilityOf(gateId: string): { skippable: boolean; reason: string } {
    const decl = GATE_SURFACE[gateId];
    if (decl === undefined) {
      return {
        skippable: false,
        reason: `表面表里没有 ${gateId} ⇒ 无法证明其输入与改动无关，按"永不跳过"处理（请取证后补声明）`,
      };
    }
    if (decl.audited === '') {
      return { skippable: false, reason: `${gateId} 的声明**尚未经实测核对** ⇒ 按"永不跳过"处理` };
    }
    if (decl.inputs === undefined || decl.inputs.length === 0) {
      return { skippable: false, reason: `${gateId} 的判定输入未取证 ⇒ 按"永不跳过"处理` };
    }
    return { skippable: true, reason: decl.why };
  }

  /**
   * 改动集是否碰到了该门禁的判定输入。
   *
   * **不可跳过的门禁一律返回 `hit: true`**——这样"不可跳过"与"碰巧命中"在调用方是同一处置，
   * 不存在"因为没命中所以跳过了一条其实不可证明的门禁"这条路径。
   * @param gateId 门禁 id。
   * @param changedFiles 改动文件（仓库相对，正斜杠）。
   * @returns 判定结果。
   */
  public static touches(
    gateId: string,
    changedFiles: readonly string[],
  ): { hit: boolean; skippable: boolean; why: string; hits: readonly string[] } {
    const { skippable, reason } = BoostGateSurface.skippabilityOf(gateId);
    const decl = GATE_SURFACE[gateId];
    if (!skippable || decl?.inputs === undefined) {
      return { hit: true, skippable: false, why: reason, hits: [] };
    }
    const inputs = decl.inputs;
    const hits = changedFiles.filter((f) => inputs.some((p) => BoostGateSurface.matches(p, f)));
    return { hit: hits.length > 0, skippable: true, why: reason, hits: hits.slice(0, 4) };
  }
}
