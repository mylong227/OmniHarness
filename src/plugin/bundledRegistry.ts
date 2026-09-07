import type { PluginManifest } from './manifest.js';

/**
 * @beta
 * 打包的示范插件清单（仓库内置，离线可用）。
 *
 * 对应 P2.5「示例插件市场仓库骨架」。这些插件源码位于 `examples/plugins/<name>/`，
 * 由 `BundledSource` 经 `localPath` 解析并供 `plugin install` 复制安装。
 * 未来接远程 registry 后，此处可仅保留「官方推荐」子集，远程源补充长尾。
 */
export interface BundledPlugin extends PluginManifest {
  /** 相对于仓库根目录的插件目录（BundledSource 据此复制安装）。 */
  readonly localPath?: string;
  /** 远程下载地址（若同时有 localPath 则优先本地）。 */
  readonly downloadUrl?: string;
}

/**
 * @beta
 */
export const BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  {
    name: 'github-tools',
    version: '0.1.0',
    description: 'GitHub 仓库/Issue 检索（声明 net.connect）',
    author: 'OmniHarness Samples',
    permissions: ['net.connect'],
    entry: 'index.js',
    source: 'bundled',
    localPath: 'examples/plugins/github-tools',
  },
  {
    name: 'web-fetch',
    version: '0.1.0',
    description: '抓取网页并抽取正文文本（声明 net.connect）',
    author: 'OmniHarness Samples',
    permissions: ['net.connect'],
    entry: 'index.js',
    source: 'bundled',
    localPath: 'examples/plugins/web-fetch',
  },
  {
    name: 'pdf-read',
    version: '0.1.0',
    description: '读取本地 PDF 抽取文本（声明 fs.read）',
    author: 'OmniHarness Samples',
    permissions: ['fs.read'],
    entry: 'index.js',
    source: 'bundled',
    localPath: 'examples/plugins/pdf-read',
  },
  {
    name: 'hello-tool',
    version: '0.1.0',
    description: '示例工具插件：注册 hello 工具验证插件闭环（无敏感权限）',
    author: 'OmniHarness Samples',
    permissions: [],
    entry: 'index.js',
    source: 'bundled',
    localPath: 'examples/plugins/hello-tool',
  },
];
