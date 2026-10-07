// 代码查看表面：语法高亮正文 + 行号 gutter（截图式三栏壳的右栏"编辑器"观感）。
//
// 为什么行号用独立 gutter 列而不是把行号拼进高亮文本：highlightCode 是**整段分词**的
// （跨行 token、逐字符 esc），按行拆开再逐行高亮会丢掉跨行上下文；独立 gutter 只要求
// 两列的 font/line-height 一致即可对齐（正文 `white-space:pre` 不换行，行数恒等于行号数）。
// 滚动由外层 `.code-scroll` 统一承担（两列同流，天然同步）。
//
// 函数组件范式：无内部状态；行号序列为模块级纯函数。

import { React } from '../deps.js';
import { highlightCode } from '../highlight.js';

/** CodeSurface 组件的入参。 */
export interface CodeSurfaceProps {
  /** 源码文本（已截断到预览上限）。 */
  content: string;
  /** 高亮语言 id（来自 `langOf`；空串退化为纯文本）。 */
  lang: string;
}

/**
 * 生成 1..N 的行号节点列表（N = 源码行数）。
 * @param content 源码文本
 * @returns 行号节点数组（每行一个 div）
 */
function gutterRows(content: string): ReactElement[] {
  const lines = content.split('\n').length;
  const rows: ReactElement[] = [];
  for (let i = 1; i <= lines; i++) {
    rows.push(
      <div key={i} className="code-ln" aria-hidden="true">
        {String(i)}
      </div>,
    );
  }
  return rows;
}

/**
 * 代码表面：行号 gutter + 高亮正文，整体装在一个共同滚动的容器里。
 * @param props 组件入参
 * @returns 代码表面节点（空内容返回 null）
 */
export function CodeSurface(props: CodeSurfaceProps): ReactElement | null {
  const { content, lang } = props;
  const code = highlightCode(content, lang);
  if (code === null) return null;
  return (
    <div className="code-scroll" role="region" aria-label="代码内容">
      <div className="code-gutter">{gutterRows(content)}</div>
      {code}
    </div>
  );
}
