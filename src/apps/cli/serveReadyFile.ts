/**
 * `serve` 的机器可读就绪文件（桌面客户端专用，2026-10-24）。
 *
 * 背景：`serve` 目前只把 UI URL 打到 stdout，桌面端解析它既脆弱又会把 Token 带进日志。
 * 这里提供一个**不含 Token** 的原子就绪文件：绑定成功后写入 `{protocol,pid,host,port,...}`，
 * 客户端轮询它并再调 `/readyz` 确认应用就绪；Token 由客户端经 `OMNI_SERVE_TOKEN` 注入。
 *
 * 边界：
 * - 文件只含非敏感信息（端口/pid/工作区/版本），**绝不写 Token**；
 * - 先写临时文件再 `rename`，读者不会看到半截 JSON；
 * - 正常退出删除；异常退出留下的陈旧文件由客户端按 `pid` 判活后清理。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 就绪文件内容（`protocol` 是壳/侧车握手版本，不是 API 版本）。 */
export interface ServeReadyInfo {
  /** 握手协议版本；桌面客户端硬校验。 */
  readonly protocol: 1;
  /** 侧车进程 PID。 */
  readonly pid: number;
  /** 绑定地址（通常 `127.0.0.1`）。 */
  readonly host: string;
  /** 实际监听端口（`--port 0` 时由系统分配）。 */
  readonly port: number;
  /** 工作区根。 */
  readonly workspace: string;
  /** Harness 公开 API 版本（来自 `src/version.ts`）。 */
  readonly apiVersion: string;
  /** Harness 包/构建版本（当前与 API_VERSION 同源，后续可独立）。 */
  readonly harnessVersion: string;
  /** 启动时刻（ISO 8601）。 */
  readonly startedAt: string;
}

/** 就绪文件读写。 */
export class ServeReadyFile {
  private constructor() {}

  /**
   * 原子写入就绪信息。
   * @param path 目标路径（绝对路径）。
   * @param info 就绪信息。
   * @returns 实际写入路径。
   */
  public static write(path: string, info: ServeReadyInfo): string {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    return path;
  }

  /**
   * 删除就绪文件（只删自己的路径；不存在时静默）。
   * @param path 目标路径。
   * @returns 无返回值。
   */
  public static remove(path: string): void {
    rmSync(path, { force: true });
  }
}
