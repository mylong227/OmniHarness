/**
 * 产物词项编解码（单一实现，杜绝两处分隔符口径漂移）。
 *
 * 分隔符用 NUL：BM25 分词器只产出字母数字/CJK 片段，不可能包含 NUL；空文档编码为
 * 空串，解码为空数组（与原 `string[]` 语义一致）。
 */
export class CorpusFileArtifactCodec {
  /** 词项分隔符（NUL；不会出现在 token 中）。 */
  private static readonly SEP = '\u0000';

  /**
   * 编码词项数组。
   * @param tokens 词项列表。
   * @returns 分隔串（空数组 → 空串）。
   */
  public static encode(tokens: readonly string[]): string {
    return tokens.join(CorpusFileArtifactCodec.SEP);
  }

  /**
   * 解码词项串。
   * @param encoded 分隔串。
   * @returns 词项数组（空串 → 空数组）。
   */
  public static decode(encoded: string): string[] {
    return encoded === '' ? [] : encoded.split(CorpusFileArtifactCodec.SEP);
  }
}
