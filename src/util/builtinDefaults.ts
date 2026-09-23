import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * ## 路径口径
 *
 * 数据目录按**模块自身位置**反推包根（`dist/src/util/` → `../../..` → 包根 `/defaults`），
 * 与 `cliBuildConfig.createRegistry` 解析 `examples/catalog/registry.json` 同一套口径；
 * 不做 cwd 推断（否则从任意目录启动会读到别的 defaults）。`defaults/` 已登记进
 * `package.json#files`，随 npm 包一起发布。
 *
 * ## 为什么在公共层 `util/` 而不是 `config/`
 *
 * 消费方横跨两层：`security/ssrfPolicy.ts`（安全域，架构文档规定其依赖为「无」）与
 * `config/providerPresets.ts`（装配层）。若把加载器放进 `config/`，就会长出
 * `security → config` 的**反向依赖**（域原语依赖装配层）。放在 `util/` 则两条边都指向公共层，
 * 与 `ARCHITECTURE_SPEC.md` §2.1 的目录归属表一致。本模块只依赖 node 内置，无业务语义。
 */
export class BuiltinDefaults {
  /** 数据目录绝对路径（包根下的 `defaults/`）。 */
  private readonly dir: string;
  /** 解析结果缓存：文件名（不含扩展名）→ 已解析 JSON。同一数据在全进程只读一次。 */
  private readonly cache = new Map<string, unknown>();

  /**
   * @param dir 数据目录绝对路径（见文件末尾默认实例的解析口径）。
   */
  public constructor(dir: string) {
    this.dir = dir;
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
 */
export const builtinDefaults = new BuiltinDefaults(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'defaults'),
);
