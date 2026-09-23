import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 向上查找包根的级数上限（随包布局 `dist/src/util` 需 3 级；留 1 级余量）。 */
const MAX_UPWARD_LEVELS = 4;

/**
 * 内建默认数据加载器（`defaults/*.json`）——把此前写死在 `.ts` 里的「策略表 / 厂商目录」
 * 移出代码，改为随包发布的声明式数据。
 *
 * ## 为什么（用户指令：不要在代码里硬编码，方便以后维护）
 *
 * 云元数据地址、内网域名后缀、私有网段、厂商端点与模型清单都是**随环境/厂商变化的数据**，
 * 不是逻辑。原先改一条要么改实现代码重新发布，要么在多个文件里手工同步（`argParser.ts`
 * 的 `ADAPTER_PRESETS` 就是 `providerPresets.ts` 的手工副本 ⇒ 加一家厂商要改两处）。
 * 现统一从 `defaults/` 读：**改数据不改代码**，用户侧另有 `omniharness.json` 覆盖。
 *
 * ## 缺文件为什么必须抛错（fail-closed，不静默降级）
 *
 * 这些表里含着**安全默认档**（SSRF 的元数据主机 / 私有网段）。若读不到就静默退化成空表，
 * 护栏会「看着还在、实际更松」——正是本仓禁止的假绿。故缺失 / 不可解析一律当场抛错，
 * 让部署问题在启动期暴露，而不是在某个请求上悄悄放行。
 *
 * ## 路径口径（包根锚点，非「写死几级」）
 *
 * 数据目录由 {@link BuiltinDefaults.locatePackageRoot} 从**模块自身目录**向上逐级查找
 * **同时含 `package.json` 与 `defaults/`** 的那一级（最近者胜）：随包布局
 * （`dist/src/util/` → 向上 3 级）与源码布局（`src/util/` → 向上 2 级）都命中，不依赖编译产物层级。
 * 不做 cwd 推断（否则从任意目录启动会读到别的 defaults）。
 *
 * **为什么要求同级有 `package.json`（这决定了它不是 fail-open）**：若只找名为 `defaults/` 的目录，
 * 一旦某一级父目录碰巧存在同名目录，就会**静默读到别的数据**——正是本项目禁止的「看着还在、实际更松」。
 * 以 `package.json` 为包根身份锚点后，命中的必然是本包根；向上 {@link MAX_UPWARD_LEVELS} 级仍找不到
 * 就**当场抛错**（fail-closed，而不是退化成相对路径硬猜）。
 *
 * ## 为什么在公共层 `util/` 而不是 `config/`
 *
 * 消费方横跨两层：`security/ssrfPolicy.ts`（安全域，架构文档规定其依赖为「无」）与
 * `config/providerPresets.ts`（装配层）。若把加载器放进 `config/`，就会长出
 * `security → config` 的**反向依赖**（域原语依赖装配层）。放在 `util/` 则两条边都指向公共层，
 * 与 `ARCHITECTURE_SPEC.md` §2.1 的目录归属表一致。本模块只依赖 node 内置，无业务语义。
 */

/** 内建数据加载器：把 `defaults/*.json` 读成进程内可复用的只读数据（详见类上方说明）。 */
export class BuiltinDefaults {
  /** 数据目录绝对路径（包根下的 `defaults/`）。 */
  private readonly dir: string;
  /** 解析结果缓存：文件名（不含扩展名）→ 已解析 JSON。同一数据在全进程只读一次。 */
  private readonly cache = new Map<string, unknown>();

  /**
   * @param dir 数据目录绝对路径（默认实例由 {@link BuiltinDefaults.locatePackageRoot} 解析；
   *   测试可直接给临时目录，构造期不做存在性校验——校验在 {@link BuiltinDefaults.json} 读取时进行）。
   */
  public constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * 由模块自身目录向上定位包根下的 `defaults/`（要求同级存在 `package.json` 作为包根身份锚点）。
   * @param start 起始目录（通常是 `dirname(fileURLToPath(import.meta.url))`）
   * @returns `defaults/` 的绝对路径（最近的一个包根）
   * @throws Error 向上 {@link MAX_UPWARD_LEVELS} 级内找不到「`package.json` + `defaults/`」时抛出
   */
  public static locatePackageRoot(start: string): string {
    let dir = resolve(start);
    for (let depth = 0; depth < MAX_UPWARD_LEVELS; depth += 1) {
      const defaults = join(dir, 'defaults');
      if (existsSync(join(dir, 'package.json')) && existsSync(defaults)) {
        return defaults;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    throw new Error(
      `未能在 ${start} 向上 ${MAX_UPWARD_LEVELS} 级内定位包根（需同时存在 package.json 与 defaults/）：` +
        `请确认 defaults/ 随包发布（package.json#files 含 "defaults"）且模块位于包内。`,
    );
  }

  /**
   * 读取并解析 `defaults/<name>.json`（结果缓存，二次调用零 IO）。
   * @param name 数据文件名（不含 `.json`，如 `ssrf` / `providers`）。
   * @returns 已解析的 JSON 值（结构校验由各消费方负责，本方法只管「读得到、解得开」）。
   * @throws Error 文件缺失、不可读或不是合法 JSON 时抛出（fail-closed，绝不静默返回空值）。
   */
  public json(name: string): unknown {
    const hit = this.cache.get(name);
    if (hit !== undefined) {
      return hit;
    }
    const file = join(this.dir, `${name}.json`);
    if (!existsSync(file)) {
      throw new Error(
        `内建默认数据缺失：${file}。请确认 defaults/ 随包发布（package.json#files 含 "defaults"）且未被删除。`,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(
        `内建默认数据不可读：${file}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `内建默认数据不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    this.cache.set(name, parsed);
    return parsed;
  }
}

/**
 * 默认加载器实例（无状态之外仅持缓存）：调用点以 `builtinDefaults.json('ssrf')` 零构造复用。
 * 数据目录＝由本模块位置向上定位的**包根**下的 `defaults/`（见类注释的路径口径）。
 */
export const builtinDefaults = new BuiltinDefaults(
  BuiltinDefaults.locatePackageRoot(dirname(fileURLToPath(import.meta.url))),
);
