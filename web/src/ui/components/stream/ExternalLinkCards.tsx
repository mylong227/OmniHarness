// 外部链接卡片：把 assistant 文本里出现的 http(s) URL 提取为可点击列表。
// 解决「模型给出部署/文档 URL 却淹没在 markdown 里」的问题——让 URL 一眼可见。
// 不做 OG 抓取（需后端代理 + 缓存 + 隐私边界），纯卡片样式已足以让链接不被忽略。
// 纯展示组件（函数组件范式）：无内部状态、无副作用。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import { hostOf } from '../../textUtils.js';

/** ExternalLinkCards 组件的入参。 */
export interface ExternalLinkCardsProps {
  /** 已从文本中提取出的 URL 列表（空数组时渲染为 null）。 */
  urls: readonly string[];
}

/**
 * 外部链接卡片：把 URL 列表渲染为主机名 + 完整地址的可点击卡片。
 * @param props 组件入参
 * @returns 链接卡片容器；无链接时返回 null
 */
export function ExternalLinkCards(props: ExternalLinkCardsProps): ReactElement | null {
  const { urls } = props;
  if (urls.length === 0) return null;
  return (
    <div className="link-cards">
      <div className="link-cards-head">🔗 外部链接 · {urls.length}</div>
      {urls.map((u) => (
        <a className="link-card" href={u} target="_blank" rel="noopener noreferrer" key={u}>
          <span className="link-card-host">{esc(hostOf(u))}</span>
          <span className="link-card-url">{esc(u)}</span>
        </a>
      ))}
    </div>
  );
}
