// 右栏「网页」标签控制器（2026-10-19）：
// 把任意地址（已启动的 dev server / 公网页面 / 工作区里的 HTML 路径）落到 iframe，
// 并维护标签的 开 / 切 / 关 / 重载 与失败原因。
//
// 为什么单独一个控制器而不是塞进 FileController：
//   · 文件预览的主语是「读一个文件的内容」，网页预览的主语是「导航到一个地址」；
//   · 两者的状态也不该混：文件标签有合并/淘汰规则，网页只有当前一个地址；
//   · FileController 已经贴近单类职责线，再加"网页"这一组方法会变成第二个上帝类。
//
// 地址判定全部委托 `models/PreviewUrl.ts`（纯逻辑可单测）；本类只做**状态搬运 + 文案映射**。

import type { AppHost, AppServices } from './AppController.ts';
import { PreviewUrl } from '../models/PreviewUrl.ts';
import type { PreviewFailure } from '../models/PreviewUrl.ts';
import { MethodBinder } from './methodBinder.ts';
import { t } from '../i18n/i18n.ts';

/** 失败原因 → 用户可读文案（键必须是 t() 字面量，i18n 门禁会扫）。 */
function failureText(reason: PreviewFailure): string {
  switch (reason) {
    case 'invalid':
      return t('地址格式无法识别：请输入 http(s):// 网址、主机:端口，或工作区文件路径');
    case 'outside':
      return t('只能预览工作区内的相对路径（不能以 /、~、盘符开头，也不能包含 ..）');
    case 'no-preview':
      return t('本地网页预览未启用（服务端没有启动预览源）');
    case 'no-host':
      return t('当前不是通过回环地址打开的界面，本地文件预览不可用');
    case 'empty':
    default:
      return t('请输入要浏览的地址');
  }
}

/** 右栏网页标签控制器。 */
export class BrowserController {
  /** 状态宿主。 */
  private readonly host: AppHost;
  /** 共享服务（api 用来问预览源端口）。 */
  private readonly services: AppServices;
  /** 预览源端口的解析结果缓存（一次页面生命周期内端口不变）。 */
  private previewPortPromise: Promise<number | null> | null = null;

  /**
   * @param host 状态宿主
   * @param services 共享服务
   */
  public constructor(host: AppHost, services: AppServices) {
    this.host = host;
    this.services = services;
    // open / show / close / reload / previewFile 都会作为裸引用传进组件 ⇒ 全部绑定。
    MethodBinder.bindAll(this);
  }

  /**
   * 导航到输入地址（绝对网址原样打开；工作区相对路径走预览源）。
   * @param input 地址栏文本
   * @returns 导航完成后 resolve（失败已落到标签的 error，不 reject）
   */
  public async open(input: string): Promise<void> {
    const text = input.trim();
    if (text === '') {
      this.host.patch((s) => ({
        browser: { ...s.browser, open: true, active: true, error: failureText('empty') },
      }));
      this.expand();
      return;
    }
    // 绝对网址不需要预览源端口；只有工作区路径才去问 /healthz（省一次请求，也让公网地址在
    // 预览源未启用时仍然可用）。
    const previewPort = PreviewUrl.absolute(text) === null ? await this.previewPort() : null;
    const parsed = PreviewUrl.parse(text, {
      appHost: BrowserController.appHost(),
      previewPort,
    });
    if (!parsed.ok) {
      this.fail(parsed.reason);
      return;
    }
    const target = parsed.target;
    this.host.patch((s) => ({
      browser: {
        open: true,
        active: true,
        url: target.url,
        title: target.title,
        reloadKey: s.browser.reloadKey + 1,
        error: '',
      },
    }));
    this.expand();
  }

  /** 打开（或切回）网页标签；地址为空时显示空态引导。 @returns 无 */
  public show(): void {
    this.host.patch((s) => ({ browser: { ...s.browser, open: true, active: true } }));
    this.expand();
  }

  /** 关闭网页标签（地址保留，下次打开可回到上一页）。 @returns 无 */
  public close(): void {
    this.host.patch((s) => ({ browser: { ...s.browser, open: false, active: false } }));
  }

  /** 重载当前页（跨源 iframe 无法调 reload，故用 key 重建）。 @returns 无 */
  public reload(): void {
    if (this.host.getState().browser.url === '') return;
    this.host.patch((s) => ({
      browser: { ...s.browser, open: true, active: true, reloadKey: s.browser.reloadKey + 1 },
    }));
  }

  /**
   * 预览一个工作区文件（HTML 等静态页）——右栏文件路径栏的「预览」按钮走这里。
   * @param path 工作区相对路径
   * @returns 导航完成后 resolve
   */
  public async previewFile(path: string): Promise<void> {
    return this.open(path);
  }

  /**
   * 导航失败：标签仍打开并展示原因，用户可以直接在地址栏改正（不静默吞掉、不弹模态）。
   * @param reason 机器可读失败原因
   * @returns 无
   */
  private fail(reason: PreviewFailure): void {
    this.host.patch((s) => ({
      browser: { ...s.browser, open: true, active: true, error: failureText(reason) },
    }));
    this.expand();
  }

  /** 展开右栏（含窄屏抽屉），保证导航结果真的看得见。 @returns 无 */
  private expand(): void {
    this.host.patch({ rightCollapsed: false, rightOpen: true });
  }

  /**
   * 预览源端口（`/healthz` 的 previewPort；失败/未启用为 null）。
   * @returns 端口或 null
   */
  private async previewPort(): Promise<number | null> {
    this.previewPortPromise ??= this.services.api
      .getPreviewPort()
      .then((port) => (typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null))
      .catch(() => null);
    return this.previewPortPromise;
  }

  /**
   * 当前 UI 的主机名（非浏览器环境返回空串，随后按「本地预览不可用」处理）。
   * @returns hostname
   */
  private static appHost(): string {
    try {
      return typeof location === 'undefined' ? '' : location.hostname;
    } catch {
      return '';
    }
  }
}
