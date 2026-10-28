// web 判据 setup（W1，随 antd 迁移新增）：只补 jsdom 缺的布局相关全局，**绝不覆盖已有全局**。
//
// 为什么现在需要：antd 组件（Tooltip/Popover 的定位、Drawer/Modal 的响应式、Tabs 的测量）
// 在 jsdom 判据里会探 `matchMedia` / `ResizeObserver`。此前自研组件不碰它们，
// 迁移后缺失会让组件判据在渲染期就抛错。
//
// 为什么放 setupFiles 而不是各测试文件自己 polyfill：13 个组件判据文件如果各自写一遍，
// 迟早漂移出第 4 个版本；统一在一处补齐，且这里只做「缺失才定义」，对既有判据零行为变更。

// jsdom 的 window 在模块加载时已存在；这里只往缺失的全局上补实现。
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;

  if (typeof w.matchMedia !== 'function') {
    // 最小实现：不匹配任何查询。需要真断点行为的判据自己在用例里 mock 覆盖。
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
  }

  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class {
      public observe(): void {}
      public unobserve(): void {}
      public disconnect(): void {}
    };
  }

  if (typeof w.requestIdleCallback !== 'function') {
    // App.ts 的空闲预取用；jsdom 无实现时退化为 setTimeout(0)。
    w.requestIdleCallback = (cb: () => void) => setTimeout(cb, 0) as unknown as number;
    w.cancelIdleCallback = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

export {};
