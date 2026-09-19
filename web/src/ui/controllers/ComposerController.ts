// 输入框切换器 / 发送相关控制器（C3 拆分，标准 class 方式）。
// 承接原 useAppController 中 send / changeModel / changeReasoning / changePermission 回调，
// 经 AppHost.patch 驱动 App 状态，行为逐字节等价。

import type { AppHost, AppServices } from './AppController.js';
import type { FileAttachment, ThreadEvent } from '../../types/models.js';
import type { ToolResultView } from '../shared.js';
import type { SessionController } from './SessionController.js';

/** 输入框 / 发送控制器：单一职责，仅供 App 组合使用。 */
export class ComposerController {
  /** 状态宿主（App class 组件）。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;
  /** 会话控制器（send 兜底分支需刷新会话列表）。 */
  private readonly sessions: SessionController;
  /** 用户主动点「停止」后本次 send 的拒绝按中断处理（写系统提示而非错误 toast）。 */
  private abortRequested = false;
  /** 是否有在飞回合（send 已发起、尚未收尾）；「停止」只对在飞回合有意义。 */
  private inFlight = false;
  /** 本回合的「已中止」系统提示是否已写过（stop 与 send 收尾二者只写一次）。 */
  private abortNoted = false;

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
    this.stop = this.stop.bind(this);
    this.regenerate = this.regenerate.bind(this);
    this.editLastUser = this.editLastUser.bind(this);
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
    this.inFlight = true;
    this.abortRequested = false;
    this.abortNoted = false;
    this.host.patch({ busy: true, activeTool: null, streamText: '', finalizedStreamText: '' });
    try {
      const res = await this.services.api.runTurn(params);
      // 用户已中止：即使后端以正常响应收尾（取消在飞请求后的回落），也不再补最终文本，
      // 统一走 finally 的中止收口，避免「停了又冒出一条回复」。
      if (this.abortRequested) return;
      if (res.threadId) {
        this.host.patch({ currentThreadId: res.threadId });
        this.host.patch((s) => {
          if (s.sessions.some((x) => x.id === res.threadId)) return s;
          const next = [{ id: res.threadId, label: prompt || (files[0] ? '📎 ' + files[0].name : '') }, ...s.sessions];
          return { sessions: next };
        });
        void this.sessions.refreshSessions();
        // F8：把新会话写进 hash，刷新 / 分享链接可直接回到该会话。
        this.services.navigate({ threadId: res.threadId });
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
      // 用户主动中断已由 stop() 即时收口（含「已中止」提示），此处不再重复报错。
      if (!this.abortRequested) {
        const msg = (e as Error).message || '未知错误';
        // 错误不再弹窗阻断，而是写进对话流作为 system 提示 + toast，页面保持可用。
        this.services.toast('运行失败：' + msg, 'err');
        this.host.patch((s) => ({
          events: [...s.events, this.systemNote('运行失败：' + msg + '。可尝试切换模型或检查 API Key。')],
        }));
      }
    } finally {
      const aborted = this.abortRequested;
      this.inFlight = false;
      this.abortRequested = false;
      // 无论正常结束、失败还是中止，都在此清掉忙碌 / 流式残留（中止时补写一次系统提示）。
      this.settleRound(aborted);
      this.abortNoted = false;
    }
  }

  /**
   * 中断在跑回合：**立即**停掉本地 UI（清忙碌与流式残留 + 写「已中止」），再通知后端取消在飞请求。
   * 立即收口是必要的：后端取消需要一次往返，若等回执，流式卡片会继续「生成中」直到响应回来。
   * @returns 无返回值。
   */
  public stop(): void {
    if (!this.inFlight || this.abortRequested) return;
    this.abortRequested = true;
    this.settleRound(true);
    void this.services.api.abortTurn().catch(() => {});
  }

  /**
   * 回合收尾：清掉忙碌态与流式残留，中止时补写一条系统提示（幂等，stop 与 send 收尾共用）。
   * @param aborted 本次收尾是否因用户中止
   * @returns 无
   */
  private settleRound(aborted: boolean): void {
    if (aborted && !this.abortNoted) {
      this.abortNoted = true;
      this.host.patch((s) => ({ events: [...s.events, this.systemNote('已中止（用户中断）。')] }));
    }
    this.host.patch((s) => ({
      busy: false,
      activeTool: null,
      liveInputs: [],
      // 已流出的半截正文收口为「已定稿」（避免它再被当成流式内容重播），并清空流式缓冲。
      finalizedStreamText: s.streamText === '' ? s.finalizedStreamText : s.streamText,
      streamText: '',
    }));
  }

  /**
   * 重生成：先请**服务端**回退到末条用户消息（截断其后的事件与工具结果），再复用既有提交通路重发。
   *
   * 为什么必须等服务端回退成功再重发：只截断视图层时，服务端存档里的旧一轮仍在，重跑等于
   * 「接着旧答案再来一轮」（且刷新页面旧回答会复活）。回退失败时**不发**——宁可不动，也不制造
   * 「看着像重生成、实际是追加」的假象。
   * @returns 异步完成
   */
  public async regenerate(): Promise<void> {
    if (this.inFlight) {
      this.services.toast('正在生成，请先停止后再重生成', 'info');
      return;
    }
    const last = this.lastUserMessage();
    if (last === null || last.text.trim() === '') {
      this.services.toast('没有可重生成的用户消息', 'info');
      return;
    }
    const threadId = this.host.getState().currentThreadId;
    if (threadId !== null) {
      const outcome = await this.services.api
        .rewindThread(threadId, last.id)
        .catch((e: unknown) => ({ ok: false, error: (e as Error).message || '未知错误' }));
      if (!outcome.ok) {
        this.services.toast('重生成失败（服务端未回退）：' + (outcome.error ?? '未知原因'), 'err');
        return;
      }
    }
    this.rewindTo(last.index);
    await this.send(last.text, [], []);
  }

  /**
   * 编辑重发：把末条用户消息填回底部输入框并聚焦，用户改完直接回车即走既有提交通路重发。
   * 不新造 RPC——重发本身完全复用 send（turns.run）。
   * @returns 无
   */
  public editLastUser(): void {
    const last = this.lastUserMessage();
    if (last === null) {
      this.services.toast('没有可编辑的用户消息', 'info');
      return;
    }
    this.host.patch((s) => ({ composerSeed: { text: last.text, nonce: (s.composerSeed?.nonce ?? 0) + 1 } }));
    this.services.toast('已填回输入框，编辑后回车重发', 'info');
  }

  /**
   * 末条用户消息（重生成 / 编辑重发的共同锚点）。
   * @returns 事件下标、事件 id 与文本；无用户消息时为 null
   */
  private lastUserMessage(): { index: number; id: string; text: string } | null {
    const events = this.host.getState().events;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev !== undefined && ev.type === 'user') {
        return { index: i, id: ev.id, text: String((ev.payload?.content as string) ?? '') };
      }
    }
    return null;
  }

  /**
   * 回退到指定事件下标（含）：截断其后的事件与工具结果，并清掉流式残留，使重跑从该点分叉。
   * @param index 保留到的事件下标（含）
   * @returns 无
   */
  private rewindTo(index: number): void {
    const kept = this.host.getState().events.slice(0, index + 1);
    this.host.patch({
      events: kept,
      toolResults: this.pruneToolResults(kept),
      liveInputs: [],
      streamText: '',
      finalizedStreamText: '',
      activeTool: null,
    });
  }

  /**
   * 按保留的事件裁剪工具结果表，避免回退后留下指向已丢弃事件的孤儿结果。
   * @param kept 回退后保留的事件
   * @returns 裁剪后的工具结果表
   */
  private pruneToolResults(kept: ThreadEvent[]): Record<string, ToolResultView> {
    const ids = new Set<string>();
    for (const ev of kept) {
      if (ev.type === 'tool_call') ids.add((ev.payload?.callId as string) || ev.id);
    }
    const prev = this.host.getState().toolResults;
    const out: Record<string, ToolResultView> = {};
    for (const id of ids) {
      const view = prev[id];
      if (view !== undefined) out[id] = view;
    }
    return out;
  }

  /**
   * 构造一条 system 事件（用于中断/失败提示写入对话流）。
   * @param content 提示文案
   * @returns 事件对象
   */
  private systemNote(content: string): ThreadEvent {
    return {
      id: 'sys-' + Date.now().toString(36),
      type: 'system',
      timestamp: Date.now(),
      payload: { content },
    };
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
