// 弹层互斥控制器：整个输入区（以及任何浮层触发器）**同时只允许一个弹层打开**。
//
// ## 为什么需要它（2026-10-17 用户实测）
//
// 输入区里四个弹层（`+` 添加菜单 / 请求批准 / 模型与强度 / 上下文容量）各自用一个
// `useState(open)` 管自己，**互相不知道对方存在**。用户先点「+」再点「请求批准」，
// 结果两个弹层都留在屏幕上、后者压在前者上面 ⇒ 截图里"背景色把文字掩盖了看不清"。
// 全站的"点外部关闭"用的是 `window.addEventListener('click', close)`，而触发器自己
// `stopPropagation()` —— 于是**打开第二个并不等于关闭第一个**，两个都活着。
//
// ## 口径
//
// 一个模块级单例，记录"当前打开者"（token）。任何组件打开自己之前先 `claim`：
//   · `claim(token)` 会先把上一个打开者关掉（调用它的 close 回调），再登记自己；
//   · 组件卸载或自行关闭时 `release(token)`（只有自己仍持有才清空）。
//
// 为什么用模块级单例而不是 React context：
//   · 这些弹层分散在 Composer / StreamView 的不同子树里，用 context 要一路透传 provider；
//   · 它本质上是一个**全局 UI 不变量**（同屏只有一个弹层），与"哪个组件树"无关。
//   这与仓库里 `DialogService`（应用级对话框）的取舍一致：全局唯一的东西用单例最直白。
//
// 判据：`web/test/popoverExclusive.test.mjs`。

/** 弹层句柄。 */
export interface PopoverHandle {
  /** 唯一标识（同一组件多次打开保持不变；用字符串便于调试与测试断言）。 */
  readonly id: string;
  /** 被"顶掉"时执行的关闭动作（由组件提供，通常是 setOpen(false)）。 */
  readonly close: () => void;
}

/** 当前打开者（module 级单例状态）。 */
let current: PopoverHandle | null = null;

/**
 * 声明"我要打开"，并把当前打开者关掉。
 *
 * 顺序很重要：**先关旧的再登记新的**。反过来的话，旧弹层的收尾动作（某些实现会在
 * close 里做清理）可能把刚登记的句柄一并清空。
 * @param handle 本次打开者
 * @returns 无
 */
export function claimPopover(handle: PopoverHandle): void {
  if (current !== null && current.id !== handle.id) {
    const prev = current;
    current = null;
    prev.close();
  }
  current = handle;
}

/**
 * 释放"我关了"。
 *
 * 只有仍持有者才生效：组件 A 被顶掉后其 effect 清理也会调用 release，
 * 若不做持有校验，它会把**新打开者**的记录抹掉，互斥随之失效。
 * @param id 打开者标识
 * @returns 无
 */
export function releasePopover(id: string): void {
  if (current !== null && current.id === id) current = null;
}

/**
 * 关闭当前弹层（`Esc` 等全局出口用）。
 * @returns 是否确实关掉了一个
 */
export function closeCurrentPopover(): boolean {
  if (current === null) return false;
  const prev = current;
  current = null;
  prev.close();
  return true;
}

/**
 * 当前打开者 id（测试与调试用；生产渲染不依赖它）。
 * @returns 打开者 id；无则 null
 */
export function currentPopoverId(): string | null {
  return current === null ? null : current.id;
}
