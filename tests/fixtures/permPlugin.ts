import type { Plugin } from '../../src/plugin/plugin.js';

/** 声明需要 proc.exec 权限的测试插件。 */
const plugin: Plugin = {
  meta: {
    name: 'perm-demo',
    permissions: ['proc.exec'],
  },
  apply(): void {
    // 无副作用
  },
};

export default plugin;
