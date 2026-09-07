/**
 * 示范插件：GitHub 检索（声明 net.connect）。
 *
 * 只注册能力、不在 apply 阶段发请求；fetch 实现可注入，便于离线测试。
 * 加载时由 PermissionGate 校验 net.connect 是否在白名单内（fail-closed）。
 */
export default {
  meta: {
    name: 'github-tools',
    permissions: ['net.connect'],
  },
  apply(ctx) {
    ctx.registerService('plugin:github-tools', {
      /** 检索仓库，返回 "full_name — description" 列表。 */
      async searchRepos(query, fetchImpl = globalThis.fetch) {
        if (typeof fetchImpl !== 'function') {
          throw new Error('github-tools: 缺少 fetch 实现');
        }
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}`;
        const response = await fetchImpl(url);
        const data = await response.json();
        return (data.items ?? [])
          .slice(0, 5)
          .map((item) => `${item.full_name} — ${item.description ?? ''}`);
      },
    });
  },
};
