// 文件类型判定：决定文件预览走「语法高亮 / markdown 渲染 / 纯文本」哪条分支。
// 纯静态逻辑、零 React 依赖，便于在 node 环境直接单测。

/** 需要语法高亮的语言集合（json 也算代码类）。 */
const CODE_LANGS: ReadonlySet<string> = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'html',
  'sh',
  'py',
  'rs',
  'go',
  'sql',
  'java',
  'json',
]);

/** Markdown 语言标识集合。 */
const MD_LANGS: ReadonlySet<string> = new Set(['md', 'markdown']);

/** 文件种类分类器。 */
export class FileKindClassifier {
  /** 是否代码类（走语法高亮）。未知语言一律否（fail-closed 到纯文本，不出错）。 */
  public static isCode(lang: string | undefined): boolean {
    return typeof lang === 'string' && CODE_LANGS.has(lang.toLowerCase());
  }

  /** 是否 markdown（走渲染器）。 */
  public static isMarkdown(lang: string | undefined): boolean {
    return typeof lang === 'string' && MD_LANGS.has(lang.toLowerCase());
  }

  /** 明确分类：三选一，未知归 plain。 */
  public static classify(lang: string | undefined): 'code' | 'markdown' | 'plain' {
    if (FileKindClassifier.isCode(lang)) return 'code';
    if (FileKindClassifier.isMarkdown(lang)) return 'markdown';
    return 'plain';
  }
}
