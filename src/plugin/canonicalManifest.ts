/**
 * 清单规范化（2026-10-21 从 `PluginBundler` 拆出，供 bundle 与插件安装验签共用）。
 *
 * 为什么独立：`PluginSignature` 需要同一份「稳定键序、剔除签名字段」口径，但直接 import
 * `PluginBundler` 会形成 `pluginRegistry → pluginSignature → pluginBundler → pluginRegistry`
 * 的依赖环（架构门禁会拦）。把纯函数下沉到这里，两个消费方都只依赖它。
 */
export class CanonicalManifest {
  /**
   * 规范化清单：剔除 `signature` / `signatureEd25519`，其余字段按**每一层**键排序序列化。
   *
   * 为什么不能用 `JSON.stringify(value, sortedKeys)`：replacer 数组会递归裁剪对象键，
   * 只保留顶层白名单里的同名键 ⇒ `plugins[].from/localPath` 等嵌套字段完全不在签名覆盖内
   * （改补丁值仍报 verified）。本方法保留全部嵌套字段，只稳定键序。
   * @param value 清单对象（bundle 或插件 manifest）。
   * @returns 稳定键序的规范化 JSON（不含任何签名字段）。
   */
  public static of(value: Record<string, unknown>): string {
    const { signature: _omit, signatureEd25519: _omitEd, ...rest } = value;
    return CanonicalManifest.stable(rest);
  }

  /**
   * 递归稳定序列化：每一层键排序，数组保序，`undefined` 键省略（与 JSON.stringify 一致）。
   * @param value 任意 JSON 值。
   * @returns 稳定序列化字符串。
   */
  private static stable(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => CanonicalManifest.stable(item)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${CanonicalManifest.stable(item)}`);
      }
      return `{${parts.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }
}
