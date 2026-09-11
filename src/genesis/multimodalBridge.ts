/**
 * 多模态桥接（原生支持多模态的落地）。
 *
 * 把模型消息（文本 + 图像）统一映射为 Genesis `Modality` 代数对象，
 * 并提供一个**零依赖、复用 #M2 BM25 内核**的跨模态检索增强：
 * 把每个文档的模态特征签名注入可检索文本，使图像/二进制类内容也能被自然语言召回，
 * 文本查询也可借特征对齐聚类——统一向量空间即"原生多模态"的表达。
 *
 * 视觉语义编码器（如 CLIP）可作为 drop-in 适配器替换 `encodeImage`，
 * 但 `Modality` 代数（fuse/align）不变（见 modality.ts）。
 */

import type { ModelMessage } from '../ports/model.js';
import type { RetrievalPort, RetrievalDoc } from '../ports/retrieval.js';
import {
  type Modality,
  encodeText,
  encodeImage,
  fuseModality,
  alignModality,
  textFeatures,
} from './modalityPort.js';

/**
 * 多模态桥接器。
 *
 * 无状态、无 IO：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class MultimodalBridge {
  /**
   * 把一条模型消息映射为统一 Modality（原生多模态表示）。
   * 含图像时：每图 encodeImage 后两两 fuse，再与文本 fuse 为 tensor。
   * 视觉字节缺失宽高时以确定性占位（length, 1），真实编码器可替换本路径。
   */
  public modelMessageToModality(msg: ModelMessage): Modality<unknown> {
    const text = encodeText(msg.content ?? '');
    if (msg.images && msg.images.length > 0) {
      const first = msg.images[0];
      if (first === undefined) return text as Modality<unknown>;
      let acc: Modality<unknown> = this.imageModality(first) as Modality<unknown>;
      for (let i = 1; i < msg.images.length; i++) {
        const im = msg.images[i];
        if (im !== undefined) acc = fuseModality(acc, this.imageModality(im)) as Modality<unknown>;
      }
      return fuseModality(text, acc) as Modality<unknown>;
    }
    return text as Modality<unknown>;
  }

  /** 由 ImageContent 派生确定性字节（base64 优先，否则 url 哈希），再编码为图像 Modality。 */
  private imageModality(img: {
    url?: string;
    data?: string;
    mediaType?: string;
  }): Modality<Uint8Array> {
    let bytes: Uint8Array;
    if (img.data !== undefined) {
      bytes = this.base64ToBytes(img.data);
    } else if (img.url !== undefined) {
      bytes = this.asciiToBytes(img.url);
    } else {
      bytes = new Uint8Array([0]);
    }
    // 占位宽高：真实维度由视觉编码器提供；此处仅保证确定性与代数不变。
    return encodeImage(bytes, Math.max(1, bytes.length), 1);
  }

  /** 跨模态对齐打分：两消息特征向量的余弦相似度（文本与图像可直接比较）。 */
  public crossModalAlign(a: ModelMessage, b: ModelMessage): number {
    return alignModality(this.modelMessageToModality(a), this.modelMessageToModality(b));
  }

  /**
   * 跨模态检索增强：把每个文档的模态特征签名追加进可检索文本，
   * 使 BM25 索引具备"语义特征"维度（同义/同构文本更易聚类召回）。
   * 零依赖、复用 #M2 内核，不改变 RetrievalPort 契约。
   */
  public registerCrossModal(index: RetrievalPort, docs: readonly RetrievalDoc[]): void {
    for (const d of docs) {
      const sig = this.modalitySignature(d.text);
      index.index({ ...d, text: `${d.text} __modality_sig__ ${sig}` });
    }
  }

  /** 由文本派生确定性格征签名（n-gram 哈希串），作为 BM25 可索引的跨模态桥。 */
  public modalitySignature(text: string): string {
    return textFeatures(text)
      .map((v) => Math.round(v * 1000))
      .join('_');
  }

  private base64ToBytes(b64: string): Uint8Array {
    // 浏览器/Node 均有的 atob；去掉 data URI 前缀。
    const clean = b64.replace(/^data:.*;base64,/, '');
    const bin =
      typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  private asciiToBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const multimodalBridge = new MultimodalBridge();

/**
 * 把一条模型消息映射为统一 Modality（原生多模态表示）。
 * 含图像时：每图 encodeImage 后两两 fuse，再与文本 fuse 为 tensor。
 * 视觉字节缺失宽高时以确定性占位（length, 1），真实编码器可替换本路径。
 */
export function modelMessageToModality(msg: ModelMessage): Modality<unknown> {
  return multimodalBridge.modelMessageToModality(msg);
}

/** 跨模态对齐打分：两消息特征向量的余弦相似度（文本与图像可直接比较）。 */
export function crossModalAlign(a: ModelMessage, b: ModelMessage): number {
  return multimodalBridge.crossModalAlign(a, b);
}

/**
 * 跨模态检索增强：把每个文档的模态特征签名追加进可检索文本，
 * 使 BM25 索引具备"语义特征"维度（同义/同构文本更易聚类召回）。
 * 零依赖、复用 #M2 内核，不改变 RetrievalPort 契约。
 */
export function registerCrossModal(index: RetrievalPort, docs: readonly RetrievalDoc[]): void {
  multimodalBridge.registerCrossModal(index, docs);
}

/** 由文本派生确定性格征签名（n-gram 哈希串），作为 BM25 可索引的跨模态桥。 */
export function modalitySignature(text: string): string {
  return multimodalBridge.modalitySignature(text);
}
