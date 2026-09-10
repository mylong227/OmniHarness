// 产物卡片：写类工具成功后展示——文件名 + 工作区路径 + 打开 / 下载。
// 点击文件名或「打开」在右侧代码面板预览（语法高亮），下载直跳 /files。

import { React } from '../../deps.js';
import { esc } from '../../format.js';
import type { ArtifactInfo } from '../../models/ArtifactResolver.js';

export interface ArtifactCardProps {
  info: ArtifactInfo;
  onOpen?: (path: string) => void;
}

/** 产物卡片组件。 */
export class ArtifactCard extends React.Component<ArtifactCardProps> {
  /** 打开：阻止默认跳转与冒泡（外层卡片点击会触发钻取），改走右侧面板预览。 */
  private readonly handleOpen = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { onOpen, info } = this.props;
    if (onOpen) onOpen(info.relPath);
  };

  override render(): ReactElement {
    const { info } = this.props;
    const href = `/files?path=${encodeURIComponent(info.relPath)}`;
    return (
      <div className="artifact-card">
        <span className="artifact-icon">{info.kind === 'patch' ? '🩹' : '📄'}</span>
        <div className="artifact-meta">
          <a
            className="artifact-name"
            href="#"
            onClick={this.handleOpen}
            title="在右侧面板打开（语法高亮）"
          >
            {esc(info.name)}
          </a>
          <div className="artifact-path">{esc(info.relPath)}</div>
        </div>
        <a className="artifact-open" href="#" onClick={this.handleOpen} title="在右侧面板打开">
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
}
