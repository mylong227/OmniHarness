// 文件预览 / 代码查看器控制器（从 SessionController 抽离：后者因新增文件标签方法越过
// 「单类 ≤25 方法」红线，而"打开/切换/关闭文件"本就是一条独立职责缝）。
// 职责：readFs 读取并写入 fileView、维护代码查看器的文件标签集合（openFiles，规则在
// models/FileTabs.ts）、标签切换与关闭的激活回落。全部经 AppHost.patch 驱动状态。

import type { AppHost, AppServices } from './AppController.ts';
import { langOf } from '../highlight.ts';
import { FileKindClassifier } from '../models/FileKindClassifier.ts';
import { FileTabs } from '../models/FileTabs.ts';
import type { FileView } from '../shared.ts';
import { MethodBinder } from './methodBinder.ts';
import { t } from '../i18n/i18n.ts';

/** 文件预览 / 代码查看器控制器：单一职责，仅供 App 组合使用。 */
export class FileController {
  /** 状态宿主。 */
  private readonly host: AppHost;
  /** 共享服务。 */
  private readonly services: AppServices;
  /** 打开 HTML 时自动切到网页预览（由组合根注入；缺省不自动切，供单测/无预览环境）。 */
  private readonly onPreview?: ((path: string) => void | Promise<void>) | undefined;

  /**
   * 构造并绑定对外回调。
   * @param host 状态宿主
   * @param services 共享服务
   * @param onPreview 打开网页文件时的预览回调（可选；注入后 HTML 文件默认直接渲染）
   */
  public constructor(
    host: AppHost,
    services: AppServices,
    onPreview?: (path: string) => void | Promise<void>,
  ) {
    this.host = host;
    this.services = services;
    this.onPreview = onPreview;
    // openFile / showOpenFile / closeOpenFile 均以裸引用传给子组件 ⇒ 必须绑定（见 MethodBinder）。
    MethodBinder.bindAll(this);
  }

  /**
   * 在右侧代码查看器打开一个路径（含语法高亮语言推断）。
   * F8：面板经路由写入 hash，刷新 / 前进后退可还原「正在看哪个文件」这一视图。
   * @param path 文件路径
   * @returns 是否成功打开（false 供结果卡移除已不存在的文件行）
   */
  public async openFile(path: string): Promise<boolean> {
    try {
      const r = await this.services.api.readFs(path);
      const tag = r.isBinary ? t('二进制文件') : r.truncated ? t('已截断（>200KB）') : '';
      const meta =
        tag === ''
          ? t('{size} 字节', { size: r.size ?? 0 })
          : t('{tag} · {size} 字节', { tag, size: r.size ?? 0 });
      const view: FileView = {
        // 标题只放文件名：`📄 ` 前缀已废弃（emoji 当图标，见 models/Icon.ts）；
        // 面板自己会用 `icon('file')` 表达"这是一个文件"。
        title: r.path,
        meta: meta.trim(),
        content: r.isBinary ? t('（二进制文件，无法预览）') : r.content || '',
        // 依据路径推断语言做语法高亮；二进制不参与。
        lang: r.isBinary ? '' : langOf(r.path),
      };
      this.host.patch((s) => ({
        fileView: view,
        // 代码查看器的标签页：同一文件只保留一份（后开刷新内容），其余追加在队尾。
        openFiles: FileTabs.merge(s.openFiles, view),
        // 打开文件 = 把右栏从网页切回文件（网页标签保留，地址不丢）。
        browser: s.browser === undefined ? s.browser : { ...s.browser, active: false },
      }));
      // 展开右栏与激活面板由路由收口（RouteBinding.apply），避免两处状态各写一遍。
      this.services.navigate({ pane: 'file' });
      // 静态网页默认**直接渲染**（用户口径：打开 HTML 就应该看到页面，而不是先看源码再点预览）。
      // 源文件标签仍保留在标签条里，点它即可切回源码；非网页文件不受影响。
      if (this.onPreview !== undefined && FileKindClassifier.isWebPage(view.title)) {
        void this.onPreview(view.title);
      }
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      // 旧 turn_diff 可能仍列着「生成后又被删除」的临时文件（如 _preview_server.js）。
      // 不再把原始 ENOENT 甩给用户：给一句人话，调用方（结果卡）据 false 移除该行。
      if (/ENOENT|no such file|not found/i.test(msg)) {
        this.services.toast(t('文件已不存在（可能已被删除）'), 'err');
      } else {
        this.services.toast(t('打开失败：{msg}', { msg }), 'err');
      }
      return false;
    }
  }

  /**
   * 切换到已打开文件中的某一个（代码查看器标签页点击；不重新读盘）。
   * @param title 文件路径（即 FileView.title）
   * @returns 无
   */
  public showOpenFile(title: string): void {
    const found = this.host.getState().openFiles.find((f) => f.title === title);
    if (found === undefined) return;
    this.host.patch((s) => ({
      fileView: found,
      browser: s.browser === undefined ? s.browser : { ...s.browser, active: false },
    }));
    this.services.navigate({ pane: 'file' });
  }

  /**
   * 关闭代码查看器的一个文件标签页：若是当前文件则自动落到相邻标签，全部关完则清空预览。
   * @param title 文件路径（即 FileView.title）
   * @returns 无
   */
  public closeOpenFile(title: string): void {
    this.host.patch((s) => {
      const next = FileTabs.close(s.openFiles, title, s.fileView?.title ?? null);
      return { openFiles: next.list, fileView: next.active };
    });
    if (this.host.getState().activePane !== 'file') this.services.navigate({ pane: 'file' });
  }
}
