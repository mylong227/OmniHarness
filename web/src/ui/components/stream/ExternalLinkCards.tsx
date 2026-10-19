// 外部链接卡片：把 assistant 文本里出现的 http(s) URL 提取为可点击列表。
// 解决「模型给出部署/文档 URL 却淹没在 markdown 里」的问题——让 URL 一眼可见。
// 不做 OG 抓取（需后端代理 + 缓存 + 隐私边界），纯卡片样式已足以让链接不被忽略。
//
// 2026-10-19：回环地址（`http://localhost:5173` 这类 dev server）额外给一个「预览」按钮，
// 直接把右栏网页标签导航过去——「跑起来 → 在右栏看」不用再手抄地址。
// 公网链接不显示该入口：多数站点用 X-Frame-Options 拒绝嵌入，列出来只会是假入口。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { PreviewUrl } from '../../models/PreviewUrl.ts';
import { icon } from '../../models/Icon.ts';
import { hostOf } from '../../textUtils.ts';
import { t } from '../../i18n/i18n.ts';

/** ExternalLinkCards 组件的入参。 */
export interface ExternalLinkCardsProps {
  /** 已从文本中提取出的 URL 列表（空数组时渲染为 null）。 */
  urls: readonly string[];
  /** 在右栏网页标签打开（仅回环地址显示入口；缺省不显示）。 */
  onOpenInPanel?: ((url: string) => void) | undefined;
}

/**
 * 外部链接卡片：把 URL 列表渲染为主机名 + 完整地址的可点击卡片。
 * @param props 组件入参
 * @returns 链接卡片容器；无链接时返回 null
 */
export function ExternalLinkCards(props: ExternalLinkCardsProps): ReactElement | null {
  const { urls, onOpenInPanel } = props;
  if (urls.length === 0) return null;
  return (
    <div className="link-cards">
      <div className="link-cards-head">
        {icon('link', { size: 12 })} 外部链接 · {urls.length}
      </div>
      {urls.map((u) => (
        <div className="link-card" key={u}>
          <a className="link-card-main" href={u} target="_blank" rel="noopener noreferrer">
            <span className="link-card-host">{hostOf(u)}</span>
            <span className="link-card-url">{u}</span>
          </a>
          {onOpenInPanel === undefined || !PreviewUrl.isLoopbackUrl(u) ? null : (
            <button
              className="link-card-open"
              type="button"
              title={t('在右栏打开')}
              onClick={() => {
                void onOpenInPanel(u);
              }}
            >
              {t('预览')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
