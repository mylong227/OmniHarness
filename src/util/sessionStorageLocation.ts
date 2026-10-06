/**
 * 会话事件**落盘位置**的单一事实源（2026-10-06 第五十九轮，真实跑测暴露）。
 *
 * ## 为什么需要它（实测事故）
 *
 * 本轮"把软件真跑起来"时实测到：默认跑一次 `omniharness -p --prompt …`（走 `CliDefaults.storageDir`
 * = **用户级** `~/.omniharness/sessions`），紧接着 `omniharness trace read --session <id>`
 * （走**工作区相对** `<ws>/.omniharness/sessions`）**必然找不到会话**——实测报
 * `trace 读取失败: 会话未找到或无 trace`。全仓当时有 **4 处**各自声明"默认会话目录"：
 * 两处用户级（写入方 / `session` 子命令）、两处工作区相对（`trace` / `sessionArchive` 的兜底），
 * 而 `tests/unit/traceCliWiring.test.ts` 的那条判据还把工作区相对**当成正确默认**钉住，
 * 标题写着"与存储层缺省一致"——**它保护的是一个错误的行为**。
 *
 * ## 口径（本文件即裁决）
 *
 * - **默认 = 用户级**（与写入方 `CliDefaults.storageDir` 一致）：会话是"用户的历史"，不随 cwd 漂移；
 * - `--storage-dir` 显式给定时优先：绝对路径原样生效，相对路径按工作区解析（保持原语义）；
 * - 需要把会话落到别处（测试隔离 / 便携部署）用环境变量 `OMNI_SESSIONS_DIR`——**同一个旋钮**
 *   同时移动写入方与所有读取方，不会再出现"一半人换了目录"的分裂；
 * - `sessionArchive` 的兜底仍按工作区，但那只是"没有活的 StoragePort 时"的推断（serve 路径优先问
 *   存储端口本身的 `location`），与本类的语义不同，故不强行合并——差异在本注释里写明。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 会话落盘位置解析（无状态）。 */
export class SessionStorageLocation {
  /** 覆盖默认目录的环境变量名（写入方与读取方共用）。 */
  public static readonly ENV_DIR = 'OMNI_SESSIONS_DIR';

  /**
   * 默认会话目录：`OMNI_SESSIONS_DIR` 优先，否则用户级 `~/.omniharness/sessions`。
   * @returns 绝对路径。
   */
  public static defaultDir(): string {
    const configured = process.env[SessionStorageLocation.ENV_DIR];
    if (configured !== undefined && configured.trim() !== '') return configured;
    return join(homedir(), '.omniharness', 'sessions');
  }

  /**
   * 解析生效的会话目录（`--storage-dir` 语义的唯一实现）。
   * @param workspace 工作区根（解析相对路径用）。
   * @param explicit `--storage-dir` 的显式取值（未给时回落 {@link defaultDir}）。
   * @returns 绝对路径。
   */
  public static resolve(workspace: string, explicit: string | undefined): string {
    if (explicit === undefined || explicit.trim() === '')
      return SessionStorageLocation.defaultDir();
    // 用 resolve 而非 join：`join` 不认右侧的绝对路径（会把盘符再拼一次），
    // 而 `--storage-dir D:\sessions` 这类显式绝对路径必须原样生效。
    return resolve(workspace, explicit);
  }
}
