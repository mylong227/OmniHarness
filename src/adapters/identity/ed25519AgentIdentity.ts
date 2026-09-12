/**
 * Ed25519 Agent 身份适配器（#S33，对标 codex-rs/agent-identity 可移植核心）。
 *
 * 零依赖：仅用 Node 内置 `node:crypto`。Ed25519 由 Node 原生支持，无需任何运行时包。
 * 密钥以 PKCS#8 der base64 持久化（与参考 Rust 的 `private_key_pkcs8_base64` 同构），
 * 公钥以 ssh-ed25519 字符串编码（与参考 `encode_ssh_ed25519_public_key` 同构）。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type {
  AgentIdentityClaims,
  AgentIdentityConfig,
  AgentIdentityPort,
} from '../../ports/agentIdentity.js';

/** 密钥派生上下文（参考 Rust `AGENT_IDENTITY_KEY_DERIVATION_CONTEXT`）。 */
const KEY_DERIVATION_CONTEXT = 'omniharness-agent-identity-ed25519-v1';

/** Ed25519 公钥原始字节长度。 */
const ED25519_PUBLIC_BYTES = 32;

/** 生成一段短随机 hex（用于缺省 runtime id）。 */
function randomSuffix(): string {
  const buf = generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'der',
  }) as Buffer;
  return buf.subarray(0, 8).toString('hex');
}

/** 把一段字节按 SSH 字符串格式（4 字节大端长度 + 内容）写入 blob。 */
function appendSshString(blob: Buffer, offset: number, value: Buffer): number {
  blob.writeUInt32BE(value.length, offset);
  value.copy(blob, offset + 4);
  return offset + 4 + value.length;
}

/** 编码 ssh-ed25519 公钥（参考 Rust `encode_ssh_ed25519_public_key`）。 */
function encodeSshEd25519(rawSpkiDer: Buffer): string {
  // SPKI der 末尾 32 字节即原始公钥。
  const keyBytes = rawSpkiDer.subarray(rawSpkiDer.length - ED25519_PUBLIC_BYTES);
  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.alloc(4 + name.length + 4 + keyBytes.length);
  const o = appendSshString(blob, 0, name);
  appendSshString(blob, o, keyBytes);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

/** 断言信封结构（base64url 序列化）。 */
interface AgentAssertionEnvelope {
  agent_runtime_id: string;
  task_id: string;
  timestamp: string;
  signature: string;
}

/**
 * @beta
 */
export class Ed25519AgentIdentity implements AgentIdentityPort {
  private readonly runtime: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  public constructor(config?: AgentIdentityConfig) {
    this.runtime = config?.agentRuntimeId ?? `omni-${randomSuffix()}`;
    if (config?.privateKeyPkcs8Base64 !== undefined && config.privateKeyPkcs8Base64.length > 0) {
      this.privateKey = createPrivateKey({
        key: Buffer.from(config.privateKeyPkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } else {
      this.privateKey = generateKeyPairSync('ed25519').privateKey;
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  /** 运行时身份 id：显式配置的 agentRuntimeId，或自动生成的 `omni-<随机 hex>`（跨多次运行复用）。 */
  public runtimeId(): string {
    return this.runtime;
  }

  /** ssh-ed25519 格式公钥：取 SPKI der 末 32 字节原始公钥编码为 `ssh-ed25519 <base64>` 串。 */
  public publicKeySsh(): string {
    const der = this.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    return encodeSshEd25519(der);
  }

  /** PKCS#8 der 的 base64 私钥（持久化用，可回传给构造配置在下次运行复用同一身份）。 */
  public privateKeyPkcs8Base64(): string {
    return (this.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64');
  }

  /**
   * 对原始负载做 Ed25519 签名。
   * @param payload 待签名的 UTF-8 文本。
   * @returns base64 编码的签名。
   */
  public sign(payload: string): string {
    const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), this.privateKey);
    return sig.toString('base64');
  }

  /**
   * 验证原始负载的 base64 签名（fail-closed：签名非法/解码失败返回 false）。
   * @param payload 原始负载文本。
   * @param signatureB64 base64 编码的签名。
   * @returns 验签是否通过。
   */
  public verify(payload: string, signatureB64: string): boolean {
    try {
      return cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        this.publicKey,
        Buffer.from(signatureB64, 'base64'),
      );
    } catch {
      return false;
    }
  }

  /**
   * 签一个任务断言：对 `runtimeId:taskId:当前时间戳` 签名，连同声明打包为
   * base64url 序列化的信封（时间戳防重放）。
   * @param taskId 单次运行的任务 id。
   * @returns base64url 编码的断言信封。
   */
  public signAssertion(taskId: string): string {
    const timestamp = new Date().toISOString();
    const payload = `${this.runtime}:${taskId}:${timestamp}`;
    const signature = this.sign(payload);
    const envelope: AgentAssertionEnvelope = {
      agent_runtime_id: this.runtime,
      task_id: taskId,
      timestamp,
      signature,
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  }

  /**
   * 验一个任务断言信封：解码并验签，成功返回声明（runtime/task/时间戳）。
   * @param envelopeB64 base64url 编码的断言信封。
   * @returns 验签通过的声明；格式非法/字段缺失/验签失败一律返回 null（fail-closed）。
   */
  public verifyAssertion(envelopeB64: string): AgentIdentityClaims | null {
    try {
      const envelope = JSON.parse(
        Buffer.from(envelopeB64, 'base64url').toString('utf8'),
      ) as AgentAssertionEnvelope;
      if (
        typeof envelope.agent_runtime_id !== 'string' ||
        typeof envelope.task_id !== 'string' ||
        typeof envelope.timestamp !== 'string' ||
        typeof envelope.signature !== 'string'
      ) {
        return null;
      }
      const payload = `${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`;
      const ok = this.verify(payload, envelope.signature);
      if (!ok) {
        return null;
      }
      return {
        agentRuntimeId: envelope.agent_runtime_id,
        taskId: envelope.task_id,
        timestamp: envelope.timestamp,
      };
    } catch {
      return null;
    }
  }

  /** 形如 `AgentAssertion <envelope>` 的授权头（信封由 {@link signAssertion} 生成）。 */
  public authorizationHeader(taskId: string): string {
    return `AgentAssertion ${this.signAssertion(taskId)}`;
  }
}

/**
 * @beta
 * 生成可持久化的密钥物料（参考 Rust `generate_agent_key_material`）。
 */
export function generateAgentKeyMaterial(agentRuntimeId?: string): {
  privateKeyPkcs8Base64: string;
  publicKeySsh: string;
  agentRuntimeId: string;
} {
  const identity = new Ed25519AgentIdentity(
    agentRuntimeId === undefined ? undefined : { agentRuntimeId },
  );
  return {
    privateKeyPkcs8Base64: identity.privateKeyPkcs8Base64(),
    publicKeySsh: identity.publicKeySsh(),
    agentRuntimeId: identity.runtimeId(),
  };
}

export { KEY_DERIVATION_CONTEXT };
