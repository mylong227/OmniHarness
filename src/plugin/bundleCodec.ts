/**
 * `.ohb` 包读取器（G2/H1 共用的**唯一** zip-store 解析点）。
 *
 * ## 为什么抽出来
 *
 * `PrivateSkillSource`（G2，验签要用清单）与 `bundle grade`（H1，评级要用包内文件）都要读包，
 * 各写一份 zip 解析就一定会漂移——而"两边读到的包内容不一样"在分发/评级场景里
 * 等于**绕过门禁**（一个说已验签、另一个按未签名处理；一个扫到 `eval`、另一个没扫到）。
 *
 * 格式：本仓 `.ohb` 用的是**无压缩 zip store**（`Zip.zipStore`），故按本地文件头顺序解析即可，
 * 不需要 inflate。读取器对**畸形包**必须给出可读原因而不是抛不可读的错误。
 *
 * @maturity L1 — 多条目顺序解析 / 缺清单可读拒 / 非 zip 可读拒 / 与打包器往返 判据钉死
 * @maturityEvidence tests/unit/bundleCodec.test.ts
 */
import { readFileSync } from 'node:fs';

/** 本地文件头（zip local file header）签名。 */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** 包内清单文件名。 */
export const BUNDLE_MANIFEST_ENTRY = 'bundle.json';

/** 读取结论：成功给文件表，失败给可读原因。 */
export type BundleReadResult =
  | { readonly ok: true; readonly files: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

/** `.ohb` 读取器（纯静态；无状态）。 */
export class BundleCodec {
  private constructor() {}

  /**
   * 读包内全部条目（zip store；内容按 UTF-8 文本给出）。
   * @param path 包路径
   * @returns 文件表（相对路径 → 文本）或可读原因
   */
  public static readFiles(path: string): BundleReadResult {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (err) {
      return {
        ok: false,
        reason: `无法读取包文件：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const files = new Map<string, string>();
    let offset = 0;
    while (offset + 30 <= raw.length) {
      if (raw.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
        return files.size === 0
          ? { ok: false, reason: '不是合法的 .ohb（未找到 zip 本地文件头）' }
          : { ok: true, files };
      }
      // zip 有压缩方式字段：store ⇒ 内容原样；非 store ⇒ 本仓不产出、也不假装能读。
      const method = raw.readUInt16LE(offset + 8);
      const compressedSize = raw.readUInt32LE(offset + 18);
      const nameLength = raw.readUInt16LE(offset + 26);
      const extraLength = raw.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const name = raw.subarray(nameStart, nameStart + nameLength).toString('utf8');
      const dataStart = nameStart + nameLength + extraLength;
      if (dataStart + compressedSize > raw.length) {
        return { ok: false, reason: `包内条目 ${name} 长度越界（文件被截断）` };
      }
      if (method !== 0) {
        return {
          ok: false,
          reason: `包内条目 ${name} 使用压缩方式 ${String(method)}（本仓只产 store）`,
        };
      }
      files.set(name, raw.subarray(dataStart, dataStart + compressedSize).toString('utf8'));
      offset = dataStart + compressedSize;
    }
    // 零条目 ⇒ **不是**合法包（打包器必定写入 bundle.json）。这条必须显式判：
    // 短于一个本地文件头的垃圾文件会让上面的循环一次都不执行，不判就会"成功返回空包"——
    // 那等于把"读不出任何东西"当成"包是空的"，而空包在分级与验签里会一路静默通过。
    if (files.size === 0) {
      return { ok: false, reason: '不是合法的 .ohb（未解析到任何条目）' };
    }
    return { ok: true, files };
  }

  /**
   * 读包内清单（缺清单 ⇒ 可读原因，不是"空清单"）。
   * @param path 包路径
   * @returns 清单对象或可读原因
   */
  public static readManifestJson(
    path: string,
  ):
    | { readonly ok: true; readonly json: unknown }
    | { readonly ok: false; readonly reason: string } {
    const read = BundleCodec.readFiles(path);
    if (!read.ok) return read;
    const text = read.files.get(BUNDLE_MANIFEST_ENTRY);
    if (text === undefined)
      return { ok: false, reason: '包内缺 bundle.json 清单（不是合法 .ohb）' };
    try {
      return { ok: true, json: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, reason: '包内 bundle.json 不是合法 JSON' };
    }
  }
}
