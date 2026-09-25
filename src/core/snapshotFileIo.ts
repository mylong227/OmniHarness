import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSnapshot } from '../ports/tool/workspaceSnapshot.js';

/**
 * SnapshotFileIo —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class SnapshotFileIo {
  /** 从磁盘读取已保存的快照 JSON。 */
  public static async readSnapshotFile(path: string): Promise<FileSnapshot> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as FileSnapshot;
  }

  /** 将快照写入磁盘 JSON。 */
  public static async writeSnapshotFile(path: string, snapshot: FileSnapshot): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot), 'utf8');
  }
}

/**
 * 快照文件 IO（core 自有，零适配器依赖）。
 *
 * 从 `adapters/workspace/gitWorkspaceSnapshot.ts` 迁回 core：这两个纯函数只做
 * JSON 文件的读写，与 git 捕获/还原逻辑无关，却被 `CheckpointManager`（core）跨层
 * import，构成 core→adapters 违规。迁回后该依赖方向消除（P1 解耦）。
 */
