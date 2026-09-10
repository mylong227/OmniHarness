import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';

/**
 * 压测用脚本化模型：按序输出预设结果（驱动 PTC 与长会话）。
 * 脚本耗尽后返回固定文本，使回合自然结束。
 */
export class StressModel implements ModelPort {
  public readonly name = 'stress';
  private index = 0;

  public constructor(private readonly script: readonly ModelOutput[]) {}

  /**
   * 按序取下一个输出。
   * 摘要请求（tools 为空，来自压缩器）不消耗脚本，直接返回固定摘要——
   * 否则压缩器复用主模型会把步骤脚本项吃掉，导致回合错乱。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    if (request.tools.length === 0) {
      return { text: '【压测摘要】较早历史已折叠' };
    }
    const output = this.script[this.index];
    this.index += 1;
    return output ?? { text: '脚本结束' };
  }
}
