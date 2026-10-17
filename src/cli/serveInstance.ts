/**
 * `serve` **实例记录**（2026-10-15，销看板 §8.17 那条"未修边界"）。
 *
 * ## 为什么还要一个文件（`/healthz` 不是已经报 pid 了吗）
 *
 * §8.17 把"端口被占"从一句 `EADDRINUSE` 变成了可行动诊断，但那条路只在**有人应答**时成立：
 * 进程已经死了、端口被别人抢走、或用户根本不记得上次用的是哪个端口时，健康体什么都问不到。
 * 而排障第一问恰恰是"上一个跑在这台机器上的 serve 是谁、什么时候起的、在哪个工作区"。
 *
 * ## 三条纪律（都有判据）
 *
 * 1. **只删自己的记录**：`retire()` 核对记录里的 pid 与本进程一致才删——否则删掉的就是别人的记录，
 *    而"记录被顺手删了"比"记录陈旧"更难查（与 `WorkflowRunLock` 的"只删自己的锁"同口径）。
 * 2. **脏记录当"没有记录"**：非法 JSON / 缺字段 / pid 非正整数一律返回 `null`（fail-closed）——
 *    宁可说"我不知道上次是谁"，也不拿半条记录去误导排障。
 * 3. **pid 判活把 EPERM 当存活**：能发信号但没权限（EPERM）说明进程在，只是不属于我们；
 *    判死只在 ESRCH（或非 Windows 的等价错误）时成立。
 *
 * ## 它**不是**锁
 *
 * 记录不做互斥（真正的互斥是操作系统的端口绑定，任何自研锁都只会更弱）。它的价值是
 * **可识别 + 可清扫**：绑定成功后写下，正常退出时删掉，进程意外消失时由下次启动清扫。
 * 默认**绝不**因为记录存在就去杀任何进程。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一条 serve 实例记录（自描述：足以让人判断"这是谁、什么时候、在哪儿"）。 */
export interface ServeInstanceRecord {
  /** 进程 PID。 */
  readonly pid: number;
  /** 绑定地址（如 `127.0.0.1`）。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
  /** 启动时刻（ISO 8601）。 */
  readonly startedAt: string;
  /** 工作区根（排障时最想知道的一项）。 */
  readonly workspace: string;
  /** 程序版本。 */
  readonly version: string;
}

/** serve 实例记录：写、读、清扫、退役。 */
export class ServeInstance {
  private constructor() {}

  /**
   * 记录目录（用户级：与 `daemon.pid` / 会话存档同一层）。
   * @param home 家目录（缺省 `os.homedir()`；判据注入临时目录以保持离线与 hermetic）。
   * @returns 记录目录绝对路径。
   */
  public static dirOf(home: string = homedir()): string {
    return join(home, '.omniharness');
  }

  /**
   * 某端口的记录文件路径（一端口一份，互不覆盖）。
   * @param port 端口。
   * @param home 家目录（缺省 `os.homedir()`）。
   * @returns 记录文件绝对路径。
   */
  public static pathFor(port: number, home: string = homedir()): string {
    return join(ServeInstance.dirOf(home), `serve-${String(port)}.pid`);
  }

  /**
   * 写下本实例记录（先写临时文件再 `rename` 换入：读者永远看不到半截 JSON）。
   * @param record 记录内容。
   * @param path 目标路径（缺省按 `record.port` 推导）。
   * @returns 实际写入的路径。
   */
  public static announce(record: ServeInstanceRecord, path?: string): string {
    const target = path ?? ServeInstance.pathFor(record.port);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
    return target;
  }

  /**
   * 读取记录（结构不合法一律当"没有记录"，不抛错、不半信）。
   * @param path 记录文件路径。
   * @returns 记录；缺失或脏数据时为 null。
   */
  public static read(path: string): ServeInstanceRecord | null {
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const raw = parsed as Record<string, unknown>;
    const pid = raw['pid'];
    const port = raw['port'];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return null;
    return {
      pid,
      port,
      host: typeof raw['host'] === 'string' ? raw['host'] : '',
      startedAt: typeof raw['startedAt'] === 'string' ? raw['startedAt'] : '',
      workspace: typeof raw['workspace'] === 'string' ? raw['workspace'] : '',
      version: typeof raw['version'] === 'string' ? raw['version'] : '',
    };
  }

  /**
   * 进程是否存活：能发信号即存活（**EPERM 也算存活**——进程在，只是不属于我们）。
   * @param pid PID。
   * @param probe 发信号探针（缺省 `process.kill(pid, 0)`；判据注入以离线覆盖 EPERM/ESRCH 两条分支）。
   * @returns 存活为 true；ESRCH（进程不存在）为 false。
   */
  public static isAlive(
    pid: number,
    probe: (pid: number) => void = (target) => process.kill(target, 0),
  ): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      probe(pid);
      return true;
    } catch (error) {
      // EPERM：进程存在但无权限发信号 ⇒ 存活。其余（ESRCH / EINVAL）按不存在处理。
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * 退役本实例记录：**只删自己的**（记录里的 pid 必须是本进程）。
   * @param path 记录文件路径。
   * @returns 删掉了返回 true；不是自己的记录 / 没有记录返回 false。
   */
  public static retire(path: string): boolean {
    const record = ServeInstance.read(path);
    if (record === null || record.pid !== process.pid) return false;
    rmSync(path, { force: true });
    return true;
  }

  /**
   * 清扫**已死**进程留下的记录（自愈：不会让陈旧记录长期撒谎）。
   *
   * 活着的持有者记录**原样保留**（那是正在跑的实例，删了就是删别人的记录）。
   * @param path 记录文件路径。
   * @param aliveFn 存活判定（缺省 {@link ServeInstance.isAlive}；判据注入以离线覆盖两条分支）。
   * @returns 是否清扫了、以及被清扫的那条记录（无记录时为 null）。
   */
  public static sweep(
    path: string,
    aliveFn: (pid: number) => boolean = (pid) => ServeInstance.isAlive(pid),
  ): { readonly swept: boolean; readonly record: ServeInstanceRecord | null } {
    const record = ServeInstance.read(path);
    if (record === null) {
      return { swept: false, record: null };
    }
    if (aliveFn(record.pid)) {
      return { swept: false, record };
    }
    rmSync(path, { force: true });
    return { swept: true, record };
  }

  /**
   * 一行人可读描述（进日志/诊断提示，不含任何猜测）。
   * @param record 记录。
   * @returns 形如 `pid=1234 启动于 2026-10-15T… 工作区 D:\ws（serve-8787.pid）`。
   */
  public static describe(record: ServeInstanceRecord): string {
    const parts = [`pid=${String(record.pid)}`];
    if (record.startedAt !== '') parts.push(`启动于 ${record.startedAt}`);
    if (record.workspace !== '') parts.push(`工作区 ${record.workspace}`);
    parts.push(`记录文件 serve-${String(record.port)}.pid`);
    return parts.join(' ');
  }
}
