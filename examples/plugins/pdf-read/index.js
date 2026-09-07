import { readFile } from 'node:fs/promises';

/**
 * 示范插件：PDF 文本抽取（声明 fs.read）。
 *
 * 实现为「尽力而为」的内容流文本还原：提取 (...) 字面串，
 * 不解压 FlateDecode 流——仅示范插件形态，不代表生产级 PDF 解析。
 *
 * 注意：read 函数默认直连 node:fs，绕开了 OmniHarness 的沙箱门禁。
 * 生产插件应改为注入经沙箱/存储端口的读取器，使声明的 fs.read 真正生效。
 */
export default {
  meta: {
    name: 'pdf-read',
    permissions: ['fs.read'],
  },
  apply(ctx) {
    ctx.registerService('plugin:pdf-read', {
      /** 抽取 PDF 可见文本（骨架实现）。 */
      async extract(filePath, readImpl = readFile) {
        const buffer = await readImpl(filePath);
        const raw = buffer.toString('latin1');
        const literals = raw.match(/\((?:\\.|[^\\()])*\)/g) ?? [];
        return literals.map((token) => token.slice(1, -1).replace(/\\([()\\])/g, '$1')).join(' ');
      },
    });
  },
};
