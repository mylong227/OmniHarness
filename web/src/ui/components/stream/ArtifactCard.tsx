// 产物卡片：写类工具成功后展示——文件名 + 工作区路径 + 打开 / 下载。
// 点击文件名或「打开」在右侧代码面板预览（语法高亮），下载直跳 /files。
// 纯展示组件（函数组件范式）：状态由 props 注入。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import type { ArtifactInfo, ArtifactKind } from '../../models/ArtifactResolver.js';

/** ArtifactCard 组件的入参。 */
export interface ArtifactCardProps {
  /** 产物元信息（类型 / 名称 / 相对路径）。 */
  info: ArtifactInfo;
  /** 点击「打开」时上抛相对路径（在右侧面板预览）。 */
  onOpen?: (path: string) => void;
}

/** 产物类型 → 图标（未知类型回落普通文件图标）。 */
const KIND_ICONS: Readonly<Record<ArtifactKind, string>> = {
  file: '📄',
  patch: '🩹',
  sketch: '✏️',
};

/**
 * 产物卡片：渲染产物图标、名称、路径与打开 / 下载入口。
 * @param props 组件入参
 * @returns 产物卡片节点
 */
export function ArtifactCard(props: ArtifactCardProps): ReactElement {
  const { info, onOpen } = props;
  const href = `/files?path=${encodeURIComponent(info.relPath)}`;
  // 打开：阻止默认跳转与冒泡（外层卡片点击会触发钻取），改走右侧面板预览。
  const handleOpen = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (onOpen) onOpen(info.relPath);
  };
  return (
    <div className="artifact-card">
      <span className="artifact-icon">{KIND_ICONS[info.kind] || KIND_ICONS.file}</span>
      <div className="artifact-meta">
        <a
          className="artifact-name"
          href="#"
          onClick={handleOpen}
          title="在右侧面板打开（语法高亮）"
        >
          {esc(info.name)}
        </a>
        <div className="artifact-path">{esc(info.relPath)}</div>
      </div>
      <a className="artifact-open" href="#" onClick={handleOpen} title="在右侧面板打开">
        👁 打开
      </a>
      <a
        className="artifact-download"
        href={href}
        download={esc(info.name)}
        title="下载到本地"
      >
        ⬇
      </a>
    </div>
  );
}
