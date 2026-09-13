// 输入框切换器 / 发送相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中 send / changeModel / changeReasoning / changePermission 回调，
// 经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { FileAttachment } from '../../types/models.js';
import type { SessionController } from './SessionController.js';

/** 输入框 / 发送控制器：单一职责，仅供 App 组合使用。 */
export class ComposerController {
  /** 状态宿主（App class 组件）。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;
  /** 会话控制器（send 兜底分支需刷新会话列表）。 */
  private readonly sessions: SessionController;

  /**
   * 构造并绑定对外回调。
   * @param host 状态宿主
   * @param services 共享服务
   * @param sessions 会话控制器（send 兜底分支需刷新会话列表）
   */
  public constructor(host: AppHost, services: AppServices, sessions: SessionController) {
    this.host = host;
    this.services = services;
    this.sessions = sessions;
    this.send = this.send.bind(this);
    this.changeModel = this.changeModel.bind(this);
    this.changeReasoning = this.changeReasoning.bind(this);
    this.changePermission = this.changePermission.bind(this);
  }

  /**
   * 发送一轮对话：标注 busy、调用后端、补 finalText 兜底事件、错误写回流 + toast。
   * @param prompt 用户输入
   * @param images 图片附件
   * @param files 文件附件
   * @returns 无
   */
  public async send(
    prompt: string,
    images: { url?: string; data?: string; mediaType?: string }[],
    files: FileAttachment[],
  ): Promise<void> {
    const currentThreadId = this.host.getState().currentThreadId;
    const params: {
      threadId?: string;
      prompt: string;
      images?: { url?: string; data?: string; mediaType?: string }[];
      files?: FileAttachment[];
    } = currentThreadId ? { threadId: currentThreadId, prompt } : { prompt };
    if (images.length > 0) params.images = images;
    if (files.length > 0) params.files = files;
    this.host.patch({ busy: true, activeTool: null, streamText: '', finalizedStreamText: '' });
    try {
      const res = await this.services.api.runTurn(params);
      if (res.threadId) {
        this.host.patch({ currentThreadId: res.threadId });
        this.host.patch((s) => {
          if (s.sessions.some((x) => x.id === res.threadId)) return s;
          const next = [{ id: res.threadId, label: prompt || (files[0] ? '📎 ' + files[0].name : '') }, ...s.sessions];
          return { sessions: next };
        });
        void this.sessions.refreshSessions();
      }
      // 兜底：若后端最后一步未产出 assistant 事件，把 finalText 补成一条 assistant 事件；
      // 流中已存在同内容则跳过避免重复。
      this.host.patch((s) => ({ events: this.services.reducers.appendFinalText(s.events, res.finalText) }));
      // 回合正常结束：流式缓冲已由 assistant 事件（或上面的兜底事件）落成事实事件，
      // 此处把残留缓冲收口，避免它与最终卡片同屏重复。
      this.host.patch((s) =>
        s.streamText === '' ? {} : { streamText: '', finalizedStreamText: s.streamText },
      );
    } catch (e) {
      const msg = (e as Error).message || '未知错误';
      // 错误不再弹窗阻断，而是写进对话流作为 system 提示 + toast，页面保持可用。
      this.services.toast('运行失败：' + msg, 'err');
      this.host.patch((s) => ({
        events: [
          ...s.events,
          {
            id: 'err-' + Date.now().toString(36),
            type: 'system',
            timestamp: Date.now(),
            payload: { content: '运行失败：' + msg + '。可尝试切换模型或检查 API Key。' },
          },
        ],
      }));
    } finally {
      this.host.patch({ busy: false, activeTool: null });
    }
  }

  /**
   * 切换当前模型并写回配置。
   * @param v 模型标识
   * @returns 无
   */
  public async changeModel(v: string): Promise<void> {
    this.host.patch({ model: v });
    try {
      await this.services.api.updateConfig({ model: v });
    } catch (e) {
      this.services.toast('切换模型失败：' + (e as Error).message, 'err');
    }
  }

  /**
   * 切换推理强度档位并写回配置。
   * @param v 档位
   * @returns 无
   */
  public async changeReasoning(v: string): Promise<void> {
    this.host.patch({ reasoning: v });
    try {
      await this.services.api.updateConfig({ reasoning: v });
    } catch (e) {
      this.services.toast('切换推理强度失败：' + (e as Error).message, 'err');
    }
  }

  /**
   * 切换权限等级并写回配置。
   * @param v 等级
   * @returns 无
   */
  public async changePermission(v: string): Promise<void> {
    this.host.patch({ permission: v });
    try {
      await this.services.api.updateConfig({ approval: v });
    } catch (e) {
      this.services.toast('切换权限等级失败：' + (e as Error).message, 'err');
    }
  }
}
