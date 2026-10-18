// RTL 组件测试脚手架（**标准 React 组件测试路径**：真实 React + jsdom）。
//
// ## 它替代了什么
//
// 此前组件判据靠 `web/test/hooksStub.ts`（手写 React 替身，产出纯数据 vnode）＋
// `vitest.workspace.ts` 把 `react` 别名指向它。那套能跑，但代价是：
//   · **测的不是真实 React**——hooks 语义、effect 时序、context、ref 全靠替身"假装"；
//   · 必须维护两个垫片（hooksStub / jsxRuntimeStub）与一条 react 别名；
//   · 标准 React 工程的组件测试是 `@testing-library/react` + jsdom，新人看到的是一套本地方言。
//
// ## 本文件的定位
//
// 只做三件事：**注入假依赖**（AppContext）、**渲染一次**、**给回一个 DOM 根**。
// 断言一律用真实 DOM（`el.className` / `el.textContent` / `el.children` / `fireEvent`）。
//
// ## 为什么需要 AppContext.Provider
//
// `web/src/ui/context.ts` 的 `useApp()` 在没有 Provider 时**直接抛错**（fail-closed 是刻意的）。
// 所以每个渲染都要包一层，注入 `api` / `toast` / `dialog`。
//
// ## 为什么 api 用 Proxy
//
// 组件会调很多 RPC（`listSessions` / `getConfig` / `listChanges` …）。逐个手写假实现既啰嗦，
// 又会随组件新增调用而失效。Proxy 让任何方法都返回一个已 resolve 的 Promise；需要特定返回值的
// 用例通过 `responses` 覆盖，其余保持"空成功"，于是判据只关心它真正断言的那条数据。
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach } from 'vitest';
import { AppContext } from '../src/ui/context.ts';
import { facadeOf } from './domFacade.ts';
import type { Facade } from './domFacade.ts';
import type { AppContextValue } from '../src/ui/context.ts';

export { act, cleanup, fireEvent, render, screen, waitFor, within };

/** 记录一次 api 调用的入参，便于断言"点了按钮是否真的发出请求"。 */
export interface ApiCall {
  /** 方法名。 */
  readonly method: string;
  /** 入参。 */
  readonly args: readonly unknown[];
}

/** `renderUi` 的选项。 */
export interface RenderUiOptions {
  /** 组件属性。 */
  readonly props?: Record<string, unknown> | undefined;
  /** 按方法名覆盖 api 返回（未覆盖的方法返回 `{}`）。 */
  readonly responses?: Record<string, unknown> | undefined;
  /**
   * **首个** api 调用的返回值（不论方法名）。
   *
   * 用途：把旧桩的"按 hook 序号预设已取到的数据"改成"让组件真的去取一份数据"。
   * 多数面板挂载后第一件事就是拉自己那份数据（`vaultList` / `auditQuery` / `listChanges`…），
   * 所以用"第一次调用给这份载荷"就能复现同一场景，同时**顺带测到真实取数路径**。
   */
  readonly firstResponse?: unknown;
  /** 覆盖 toast（默认空实现，但会记录调用）。 */
  readonly onToast?: ((message: string, kind?: string) => void) | undefined;
  /** 覆盖 dialog.confirm 的返回值（默认 true）。 */
  readonly confirmResult?: boolean | undefined;
  /**
   * 整体覆盖注入的 AppContext 成员（用例可先构造一个可变对象、渲染前往里赋 `api`）。
   * 未提供的成员仍用默认桩。
   */
  readonly app?:
    | {
        readonly api?: unknown;
        readonly toast?: unknown;
        readonly dialog?: unknown;
        readonly sessionId?: string | null;
        readonly sessionTick?: number;
      }
    | undefined;
}

/** 一次渲染的结果。 */
export interface UiRender {
  /** 组件根元素（组件渲染 null 时为 null）。 */
  readonly root: HTMLElement | null;
  /** RTL 容器（永不 null，可断言"什么都没渲染"）。 */
  readonly container: HTMLElement;
  /** 注入给组件的上下文（含 api 调用记录）。 */
  readonly app: AppContextValue & { readonly calls: ApiCall[] };
  /** 卸载。 */
  readonly unmount: () => void;
}

/**
 * 造一个"任何方法都成功"的假 api，并记录调用。
 * @param responses 按方法名覆盖返回值
 * @param calls 调用记录数组（由调用方持有，便于断言）
 * @returns 假 ApiClient
 */
function makeFakeApi(
  responses: Record<string, unknown> | undefined,
  calls: ApiCall[],
  firstResponse?: unknown,
): AppContextValue['api'] {
  let firstDone = false;
  const fallback = (method: string) => (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    const key = Object.prototype.hasOwnProperty.call(responses ?? {}, method) ? method : undefined;
    if (key !== undefined) {
      const v = (responses as Record<string, unknown>)[key];
      return Promise.resolve(typeof v === 'function' ? (v as (...a: unknown[]) => unknown)(...args) : v);
    }
    // 首个调用若给了 firstResponse 就用它（见该选项的注释）。
    if (firstResponse !== undefined && !firstDone) {
      firstDone = true;
      return typeof firstResponse === 'function'
        ? Promise.resolve((firstResponse as (...a: unknown[]) => unknown)(...args))
        : Promise.resolve(firstResponse);
    }
    return Promise.resolve({});
  };
  return new Proxy({} as AppContextValue['api'], {
    get: (_t, prop) => {
      if (typeof prop !== 'string') return undefined;
      return fallback(prop);
    },
  });
}

/**
 * 渲染一个组件（真实 React + jsdom），包好 AppContext。
 * @param Component 组件（函数组件）
 * @param options 属性与假依赖覆盖
 * @returns 渲染结果（DOM 根 + 注入的上下文 + 卸载器）
 */
export function renderUi(
  // `ElementType` 而不是 `ComponentType<Record<string, unknown>>`：具体组件的 props 是
  // 各自的接口（GraphTabProps 等），用 `Record` 收口会因**逆变**拒收它们（实测一批 TS2345）。
  Component: React.ElementType,
  options: RenderUiOptions = {},
): UiRender {
  const calls: ApiCall[] = [];
  const app: AppContextValue & { calls: ApiCall[] } = {
    api:
      (options.app?.api as AppContextValue['api'] | undefined) ??
      makeFakeApi(options.responses, calls, options.firstResponse),
    toast: (options.app?.toast as AppContextValue['toast'] | undefined) ??
      ((message, kind) => {
        options.onToast?.(message, kind);
      }),
    // 只实现组件真正会调的两次调用；DialogService 的其余成员（sink/request/settleFn/bind…）
    // 属于"渲染宿主"职责，组件不会用到，故按最小面收窄——这是测试桩与被测代码的边界例外。
    dialog: (options.app?.dialog as AppContextValue['dialog'] | undefined) ??
      ({
        confirm: () => Promise.resolve(options.confirmResult ?? true),
        prompt: () => Promise.resolve(null),
      } as unknown as AppContextValue['dialog']),
    refreshModelCatalog: () => {},
    sessionId: (options.app?.sessionId as string | null | undefined) ?? null,
    sessionTick: (options.app?.sessionTick as number | undefined) ?? 0,
    calls,
  };
  const result = render(
    React.createElement(
      AppContext.Provider,
      { value: app },
      React.createElement(Component as React.ElementType, options.props ?? {}),
    ),
  );
  return {
    root: (result.container.firstElementChild as HTMLElement | null) ?? null,
    container: result.container,
    app,
    unmount: result.unmount,
  };
}

/**
 * 取元素的直接子元素（`kids` 语义）。
 * @param el 父元素（null 时返回空数组）
 * @returns 子元素数组
 */
export function kids(el: Element | null): Element[] {
  return el === null ? [] : Array.from(el.children);
}

/**
 * 取元素的 className（`clsOf` 语义）。
 * @param el 元素（null 时返回空串）
 * @returns className
 */
export function clsOf(el: Element | null): string {
  return el === null ? '' : (el.getAttribute('class') ?? '');
}

/**
 * 取元素的全部文本（`allText` 语义：合并空白）。
 * @param el 元素（null 时返回空串）
 * @returns 文本
 */
export function allText(el: Element | null): string {
  return el === null ? '' : (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * 深度优先遍历元素树。
 * @param el 起点
 * @param visit 访问回调
 * @returns 无
 */
export function walk(el: Element | null, visit: (node: Element) => void): void {
  if (el === null) return;
  visit(el);
  for (const child of Array.from(el.children)) walk(child, visit);
}

/**
 * 按 class 找全部后代（含自身）。
 * @param root 根元素
 * @param className 单个 class 名（不含点）
 * @returns 命中的元素
 */
export function byClass(root: Element | null, className: string): Element[] {
  if (root === null) return [];
  const hit: Element[] = [];
  walk(root, (node) => {
    if (node.classList.contains(className)) hit.push(node);
  });
  return hit;
}

/**
 * 按标签名找全部后代（含自身）。
 * @param root 根元素
 * @param tag 标签名（小写）
 * @returns 命中的元素
 */
export function byTag(root: Element | null, tag: string): Element[] {
  if (root === null) return [];
  const hit: Element[] = [];
  walk(root, (node) => {
    if (node.tagName.toLowerCase() === tag.toLowerCase()) hit.push(node);
  });
  return hit;
}

// 每个用例后自动卸载：不写在各文件里，避免漏写导致 DOM 跨用例串味
//（真实 React 下这不再是"清理不清理都行"——未卸载的树会让 `screen` 查询命中上一条用例的节点）。
afterEach(() => {
  cleanup();
});

/**
 * 渲染组件并返回**外观节点**（真实 React + jsdom，形状与迁移前的纯数据 vnode 一致）。
 *
 * 这是组件判据迁移期的主要入口：渲染路径是真的（hooks/effect/context/ref 都生效），
 * 断言路径沿用既有 `kids` / `clsOf` / `allText` / `walk`，避免"为了迁框架而重写 318 处断言"。
 *
 * 需要交互时用 `fireEvent.click(node.el)`——外观节点带 `el` 字段正是为此。
 *
 * @param Component 组件
 * @param options 属性与假依赖覆盖
 * @returns 外观节点、容器、注入的上下文、卸载器
 */
export function renderFacade(
  Component: React.ElementType,
  options: RenderUiOptions = {},
): UiRender & { readonly node: Facade } {
  const ui = renderUi(Component, options);
  return { ...ui, node: facadeOf(ui.root) };
}

/**
 * 渲染一个**已构造好的 React 元素**（不是组件），返回外观节点。
 *
 * 用于 `format.ts` 这类"纯函数产出元素"的判据（`badge(...)` / `todoView(...)` /
 * `renderMarkdown(...)`）：它们没有 props 也没有组件类型，用 `renderFacade` 套不上。
 *
 * @param element 待渲染的 React 元素
 * @returns 外观节点、容器
 */
export function renderElement(element: React.ReactNode): { readonly node: Facade; readonly container: HTMLElement } {
  const result = render(React.createElement(React.Fragment, null, element));
  return { node: facadeOf(result.container.firstElementChild), container: result.container };
}

/**
 * 渲染组件、**等一次微任务落地**后再快照成外观节点。
 *
 * 为什么需要它：真实 React 下 effect 里发起的请求（`api.listChanges()` 等）会在下一个微任务
 * resolve 并触发 setState；`render` 返回时首帧仍是"读取中"，此时断言"数据区存在"必然假红。
 * 用 `act(async …)` 冲一次队列，让"假 api（Promise.resolve）→ setState → 重渲染"落地。
 *
 * 只冲**一次**微任务：本仓假 api 都是即时 resolve；需要多轮（级联请求）的用例应改用
 * `waitFor` 显式等待某个 DOM 条件——那比"多冲几次"更准确。
 *
 * @param Component 组件
 * @param options 属性与假依赖覆盖
 * @returns 外观节点、容器、注入的上下文、卸载器
 */
export async function renderFacadeAsync(
  Component: React.ElementType,
  options: RenderUiOptions = {},
): Promise<UiRender & { readonly node: Facade }> {
  const ui = renderUi(Component, options);
  await act(async () => {
    await Promise.resolve();
  });
  return { ...ui, node: facadeOf(ui.container.firstElementChild) };
}
