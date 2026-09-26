import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowDef } from './workflowTypes.js';
import { WorkflowRunner } from './workflowRunner.js';

/** 图存储目录名（位于工作区 .omniharness 下）。 */
const GRAPH_DIR = '.omniharness/graphs';

/**
 * @beta
 * 列表项（不回传完整定义，减小负载）。
 */
export interface GraphSummary {
  /** 图的唯一 ID（= 文件名去扩展）。 */
  readonly id: string;
  /** 可读名（缺省与 id 相同）。 */
  readonly name: string;
  /** 步骤数。 */
  readonly stepCount: number;
}

/**
 * @beta
 * 图定义持久化存储（对标 codex agent-graph-store）：
 * 把命名 {@link WorkflowDef} 存到 `<workspace>/.omniharness/graphs/<id>.json`。
 *
 * 设计要点（fail-closed + 零依赖）：
 * - 解析失败的旧文件在 list 中被跳过（不阻断其余），get 时抛错而非回退脏数据。
 * - id 由 name 归一化而来（仅保留 `[A-Za-z0-9_-]`，其余替换为 `-`），保证文件名安全。
 * - 读盘全部用同步 API（serve 启动/单请求内），无额外运行时依赖。
 */
export class GraphStore {
  public constructor(private readonly workspaceRoot: string) {}

  /** 图存储目录（按需创建）。 */
  private dir(): string {
    const dir = join(this.workspaceRoot, GRAPH_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /** 列出全部已存图（按 id 排序，解析失败文件跳过不阻断）。 */
  public list(): GraphSummary[] {
    const dir = this.dir();
    const out: GraphSummary[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const id = file.slice(0, -'.json'.length);
      try {
        const def = JSON.parse(readFileSync(join(dir, file), 'utf8')) as WorkflowDef;
        out.push({ id, name: def.name ?? id, stepCount: def.steps?.length ?? 0 });
      } catch {
        // 坏文件跳过：不污染列表，也不静默覆盖（由 get 显式暴露错误）。
      }
    }
    return out;
  }

  /**
   * 按 id 取完整定义；不存在返回 undefined。
   * @param id 工作流 id
   * @returns 定义；不存在为 undefined
   * @param id 工作流 id
   * @returns 定义；不存在为 undefined
   */
  public get(id: string): WorkflowDef | undefined {
    const path = join(this.dir(), `${id}.json`);
    if (!existsSync(path)) {
      return undefined;
    }
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowDef;
  }

  /**
   * 保存图定义，返回其 id（= name 归一化）。缺 name 或 name 为空视为非法（fail-closed 抛错），不写盘。
   * @param def 待保存定义（name 必填、steps 至少一步）
   * @returns 落盘后的 id（name 归一化）
   */
  public save(def: WorkflowDef): string {
    if (typeof def.name !== 'string' || def.name.trim().length === 0) {
      throw new Error('图定义缺少 name（保存的图必须有可读名）');
    }
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
      throw new Error('图定义至少需要一个步骤');
    }
    // 结构性预检（2026-09-26 审计 F17）：原先只校验 name 与「steps 非空」，环 / 悬空依赖 /
    // 重复 id 都能存盘，直到 `graph.run` 才以「存在环」这类误导性错误爆出——而那一刻用户已经
    // 以为图被正确保存了。这里复用拓扑排序做一次机械校验，把错误挡在**保存**这一步。
    WorkflowRunner.computeLevels(def.steps);
    const id = GraphStore.sanitize(def.name);
    if (id.length === 0) {
      throw new Error('name 归一化后为空，请使用字母/数字/下划线/连字符');
    }
    writeFileSync(join(this.dir(), `${id}.json`), JSON.stringify(def, null, 2) + '\n', 'utf8');
    return id;
  }

  /**
   * 删除图；不存在返回 false。
   * @param id 工作流 id
   * @returns 是否确实存在并已删除
   * @param id 工作流 id
   * @returns 是否确实存在并已删除
   */
  public delete(id: string): boolean {
    const path = join(this.dir(), `${id}.json`);
    if (!existsSync(path)) {
      return false;
    }
    rmSync(path, { force: true });
    return true;
  }

  /**
   * @beta
   * 把 name 归一化为安全文件名 id。
   */
  public static sanitize(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
