// 会话**侧车文件**（与 `.jsonl` 同目录的 UI 状态）：自定义标题 / 归档名单 / 用户指定顺序。
//
// ## 为什么单独成类
//
// 三个侧车都是「低频、整体重写、损坏即回落默认」的小 JSON：与事件流的读写语义完全不同（事件流是
// 追加、只读回放）。把它们从 `SessionArchive` 里分出来后，那个类只保留「读事件流 / 聚合用量 / 校验
// 会话文件」这族职责，不再被侧车细节撑成上帝类（编码标准门禁的「上帝类」闸）。
//
// ## 故障口径（fail-open 到默认值，不隐藏也不丢会话）
//
// 侧车缺失 / 非法 JSON / 结构不符一律回落：标题表回落空表、归档名单与顺序回落空数组。
// 也就是说「侧车坏了」的最坏后果是「自定义标题没了、归档状态没了、顺序回到时间倒序」，
// **不会**让任何会话从列表里消失（那是比丢一条元数据严重得多的失败模式）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// 排序模型（显式名次 + 新会话置顶）单独成文件：本文件只管侧车文件的读写。
import { SessionRanking, type OrderDoc } from './sessionRanking.js';

/** 自定义标题侧车文件名（`{ sessionId: title }`）。 */
const TITLE_FILE = 'sessions.meta.json';
/** 归档名单侧车文件名（`string[]`）。 */
const ARCHIVED_FILE = 'sessions.archived.json';
/** 用户指定顺序侧车文件名（v2 文档；v1 为 `string[]`，读取时兼容）。 */
const ORDER_FILE = 'sessions.order.json';

/** 会话侧车存储：标题 / 归档 / 顺序。 */
export class SessionSidecars {
  /** 取存档目录（每次调用实时求值：切换工作区后跟随）。 */
  private readonly dirOf: () => string | undefined;

  /**
   * @param dirOf 取当前存档目录的函数（缺省/undefined 时所有读写都退化为空操作）
   */
  public constructor(dirOf: () => string | undefined) {
    this.dirOf = dirOf;
  }

  /**
   * 读取自定义标题表。
   * @returns `sessionId → 标题` 映射；文件缺失/损坏时为空表
   */
  public readTitles(): Record<string, string> {
    const parsed = this.readJson(TITLE_FILE);
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  /**
   * 写入自定义标题表（整体重写）。
   * @param map `sessionId → 标题` 映射
   * @returns 无返回值。
   */
  public writeTitles(map: Record<string, string>): void {
    this.writeJson(TITLE_FILE, map);
  }

  /**
   * 读取归档名单。
   * @returns 已归档 id 列表；缺失/损坏时为空数组
   */
  public readArchived(): string[] {
    return this.readIdList(ARCHIVED_FILE);
  }

  /**
   * 写入归档名单。
   * @param ids 已归档 id 列表
   * @returns 无返回值。
   */
  public writeArchived(ids: readonly string[]): void {
    this.writeIdList(ARCHIVED_FILE, ids);
  }

  /**
   * 读取排序文档（兼容 v1 数组）。
   * @returns 排序文档；缺失/损坏时为空文档
   */
  public readOrderDoc(): OrderDoc {
    return SessionRanking.parse(this.readJson(ORDER_FILE));
  }

  /**
   * 写入排序文档（v2 形状）。
   * @param doc 排序文档
   * @returns 无返回值。
   */
  public writeOrderDoc(doc: OrderDoc): void {
    this.writeJson(ORDER_FILE, { v: 2, at: doc.at, rank: doc.rank });
  }

  /**
   * 侧车文件绝对路径。
   * @param name 文件名
   * @returns 路径；存档目录未知时 undefined
   */
  private pathOf(name: string): string | undefined {
    const dir = this.dirOf();
    if (dir === undefined) return undefined;
    return join(dir, name);
  }

  /**
   * 读一个「id 数组」侧车（非字符串项丢弃）。
   * @param name 文件名
   * @returns id 列表
   */
  private readIdList(name: string): string[] {
    const parsed = this.readJson(name);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  }

  /**
   * 写一个「id 数组」侧车。
   * @param name 文件名
   * @param ids id 列表
   * @returns 无返回值。
   */
  private writeIdList(name: string, ids: readonly string[]): void {
    this.writeJson(name, [...ids]);
  }

  /**
   * 解析侧车 JSON；缺失 / 不可读 / 非法 JSON 返回 undefined（调用方各自回落默认值）。
   * @param name 文件名
   * @returns 解析结果；失败时 undefined
   */
  private readJson(name: string): unknown {
    const path = this.pathOf(name);
    if (path === undefined || !existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  /**
   * 整体重写侧车（低频用户操作，不做增量）。
   * @param name 文件名
   * @param value 待写入的 JSON 值
   * @returns 无返回值。
   */
  private writeJson(name: string, value: unknown): void {
    const path = this.pathOf(name);
    if (path === undefined) return;
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
}
