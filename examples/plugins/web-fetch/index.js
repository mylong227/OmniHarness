/**
 * 示范插件：网页抓取 + 正文抽取（声明 net.connect）。
 *
 * 去 script/style/标签的粗略抽取，够用于摘要场景；生产级 HTML 解析建议换专用解析器。
 * fetch 实现可注入，便于离线测试。
 */
export default {
  meta: {
    name: 'web-fetch',
    permissions: ['net.connect'],
  },
  apply(ctx) {
    ctx.registerService('plugin:web-fetch', {
      /** 抓取 URL 并返回纯文本正文。 */
      async text(url, fetchImpl = globalThis.fetch) {
        if (typeof fetchImpl !== 'function') {
          throw new Error('web-fetch: 缺少 fetch 实现');
        }
        const response = await fetchImpl(url);
        const html = await response.text();
        return html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      },
    });
  },
};
