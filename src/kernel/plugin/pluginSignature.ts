import { Ed25519PublicKey } from '../util/ed25519PublicKey.ts';
import { CanonicalManifest } from './canonicalManifest.ts';
import type { PluginManifest } from './manifest.ts';

/** 带可选 Ed25519 签名字段插件清单（清单来自外部 JSON，类型上允许额外字段）。 */
type SignedPluginManifest = PluginManifest & {
  readonly signatureEd25519?: string;
  readonly publisherPublicKey?: string;
};

/**
 * 插件清单 Ed25519 验签（2026-10-21）。
 *
 * 为什么要有：`PluginRegistry.install` 此前只校验权限字符串，**清单里写了签名却从不验**，
 * 远程包被篡改也照装；`PluginSignature` 把「有签名必须验、验不过即拒」收拢到一处，
 * 安装期与（未来）加载期共用同一口径。
 *
 * 签名覆盖 `PluginBundler.canonicalManifestOf(manifest)`（与 bundle 同一规范化口径，
 * 排除签名自身字段）。注意：安装器会把 `source` 字段改写为安装来源，**验签必须在改写前**
 * 对原始清单做（见 `PluginRegistry.install`）。
 */
export class PluginSignature {
  /**
   * 校验清单签名：无签名视为通过（是否强制由调用方决定）；有签名则必须验过。
   * @param manifest 插件清单。
   * @returns `{ok:true}` 或 `{ok:false, reason}`。
   */
  public static verify(manifest: PluginManifest): { ok: true } | { ok: false; reason: string } {
    const signed = manifest as SignedPluginManifest;
    const signature = signed.signatureEd25519;
    if (typeof signature !== 'string' || signature === '') {
      return { ok: true };
    }
    const publicKey = signed.publisherPublicKey;
    if (typeof publicKey !== 'string' || publicKey.trim() === '') {
      return { ok: false, reason: '清单带 Ed25519 签名但缺少 publisherPublicKey' };
    }
    const canonical = CanonicalManifest.of(signed as unknown as Record<string, unknown>);
    return Ed25519PublicKey.verify(canonical, signature, publicKey)
      ? { ok: true }
      : { ok: false, reason: 'Ed25519 签名校验失败（清单可能被篡改）' };
  }

  /**
   * 校验并抛错（安装期 fail-closed）。
   * @param manifest 插件清单。
   * @returns 无返回值。
   * @throws Error 有签名但验不过时抛出。
   */
  public static assert(manifest: PluginManifest): void {
    const result = PluginSignature.verify(manifest);
    if (!result.ok) {
      throw new Error(`插件 "${manifest.name}" 验签失败：${result.reason}`);
    }
  }

  /**
   * 是否强制远程安装必须带 Ed25519 签名（`OMNI_PLUGIN_REQUIRE_SIGNATURE=1`）。
   * @param env 环境变量（测试可注入）。
   * @returns 强制时为 true。
   */
  public static required(env: NodeJS.ProcessEnv = process.env): boolean {
    return env['OMNI_PLUGIN_REQUIRE_SIGNATURE'] === '1';
  }
}
