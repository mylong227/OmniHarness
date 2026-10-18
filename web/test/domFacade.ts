// DOM → vnode 外观（facade）：让**真实 React 渲染**的产物满足既有断言所读的纯数据形状。
//
// ## 为什么需要这层
//
// 迁移前组件判据靠 `hooksStub` 手写 React 替身，断言直接读 `{ type, props, children }`。
// 换到真实 React + jsdom 后，渲染产物是真实 DOM；若逐条把 318 处断言改写成 DOM 查询，
// 改动面极大且容易在改写中把断言语义弄偏（"改到绿"而不是"测到对"）。
//
// 本层把「渲染后的 DOM」快照成同形状的纯数据：
//
//     <div class="cs-item cs-resume" title="…">…</div>
//       ⇒ { type: 'div', props: { className: 'cs-item cs-resume', title: '…' }, children: [...] }
//
// 于是 `kids` / `clsOf` / `allText` / `walk` 这些既有辅助函数**一字不改**继续可用，
// 而**渲染路径**已经换成真实 React（hooks 语义、effect 时序、context、ref 都是真的）。
//
// ## 边界（刻意保留）
//
// · **事件处理器不搬进 props**：vnode 外观里没有可调用的 `onClick`。要触发交互请用
//   `fireEvent.click(node.el)`——那是 RTL 的正道，也比"直接调 prop"更接近用户行为。
//   外观节点带 `el` 字段正是为此。
// · **不还原组件类型**：`type` 是标签名小写（`div` / `button`），真实 React 渲染后无从得知
//   原组件名；既有断言本来也只比较标签名与 class。
// · 文本节点按 `#text` 保留（既有断言用 `typeof === 'string'` 判断，见 `toFacade` 的 children 组装）。

/** 外观节点：形状与迁移前断言所读的 vnode 一致。 */
export interface FacadeNode {
  /** 标签名小写（文本节点为 `'#text'`）。 */
  readonly type: string;
  /** 属性表（来自 HTML 属性 + className；**不含事件处理器**）。 */
  readonly props: Record<string, unknown>;
  /** 子节点（元素为 FacadeNode，文本为 string）。 */
  readonly children: readonly (FacadeNode | string)[];
  /** 对应的真实 DOM 元素（文本节点为承载它的父元素）。交互断言请用 `fireEvent.*(node.el)`。 */
  readonly el: Element;
}

/**
 * 把 DOM 元素快照成外观节点。
 * @param el 元素
 * @returns 外观节点
 */
export function toFacade(el: Element): FacadeNode {
  const props: Record<string, unknown> = {};
  // DOM 里布尔属性是 `disabled=""`，而旧断言按 **React 语义**比 `true`（`props.disabled === true`）。
  // 这里还原成 `true`：形状对齐 React 的 props 而不是 HTML 的字符串序列化，
  // 否则每个用例都得改写成 `hasAttribute`（那属于"为了迁框架而改断言"）。
  const BOOLEAN_ATTRS = new Set([
    'disabled',
    'checked',
    'readonly',
    'hidden',
    'selected',
    'multiple',
    'open',
    'required',
  ]);
  for (const attr of Array.from(el.attributes)) {
    if (BOOLEAN_ATTRS.has(attr.name)) {
      props[attr.name] = true;
      continue;
    }
    // `class` 统一成 `className`（既有断言读的是 className，与 React 的属性名一致）。
    props[attr.name === 'class' ? 'className' : attr.name] = attr.value;
  }
  const children: (FacadeNode | string)[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      // 文本节点：**原样保留**，只丢弃完全空串。
      //
      // 为什么不折叠空白：迁移前断言读的是 `createElement` 收到的 children，而 React 不会
      // 为 JSX 的源码格式化插入文本节点 ⇒ DOM 里的文本节点与旧 vnode 一一对应。
      // 折叠空白会吃掉换行/缩进，直接打掉「代码块行尾换行必须保留」这类判据
      //（实测：`highlightCode 保留 markdown 行尾换行` 因此变红——它守的正是这个）。
      const text = child.textContent ?? '';
      if (text !== '') children.push(text);
    } else if (child.nodeType === 1) {
      children.push(toFacade(child as Element));
    }
  }
  return { type: el.tagName.toLowerCase(), props, children, el };
}

/**
 * 把 DOM 子树展平成外观节点（null 输入返回 null，用于"组件什么都没渲染"的断言）。
 * @param el 根元素（可为 null）
 * @returns 外观节点或 null
 */
export function facadeOf(el: Element | null): FacadeNode | null {
  return el === null ? null : toFacade(el);
}

/** 外观节点或 null（`renderFacade` 的返回类型）。 */
export type Facade = FacadeNode | null;

/**
 * 取直接子**元素**（迁移前 `kids` 的语义：过滤掉文本/null/false）。
 * @param n 外观节点（null 时返回空数组）
 * @returns 子元素
 */
export function kids(n: FacadeNode | null): FacadeNode[] {
  if (n === null) return [];
  return n.children.filter((c): c is FacadeNode => typeof c === 'object' && c !== null);
}

/**
 * 取 className（迁移前 `clsOf` 的语义）。
 * @param n 外观节点（null 时返回空串）
 * @returns className
 */
export function clsOf(n: FacadeNode | null): string {
  if (n === null) return '';
  const v = n.props['className'];
  return typeof v === 'string' ? v : '';
}

/**
 * 取子树全部文本（迁移前 `allText` 的语义：按顺序拼接文本节点）。
 * @param n 外观节点（null 时返回空串）
 * @returns 文本
 */
export function allText(n: FacadeNode | null): string {
  if (n === null) return '';
  const out: string[] = [];
  walk(n, (node) => {
    for (const c of node.children) if (typeof c === 'string') out.push(c);
  });
  return out.join('');
}

/**
 * 深度优先遍历外观树（迁移前 `walk` 的语义）。
 * @param n 起点
 * @param visit 访问回调
 * @returns 无
 */
export function walk(n: FacadeNode | null, visit: (node: FacadeNode) => void): void {
  if (n === null) return;
  visit(n);
  for (const c of n.children) if (typeof c === 'object' && c !== null) walk(c, visit);
}

/**
 * 按 class 找全部后代（含自身）。
 * @param n 根外观节点
 * @param className 单个 class 名
 * @returns 命中的节点
 */
export function byClass(n: FacadeNode | null, className: string): FacadeNode[] {
  const hit: FacadeNode[] = [];
  walk(n, (node) => {
    if (clsOf(node).split(/\s+/u).includes(className)) hit.push(node);
  });
  return hit;
}

/**
 * 按标签名找全部后代（含自身）。
 * @param n 根外观节点
 * @param tag 标签名（小写）
 * @returns 命中的节点
 */
export function byTag(n: FacadeNode | null, tag: string): FacadeNode[] {
  const hit: FacadeNode[] = [];
  walk(n, (node) => {
    if (node.type === tag.toLowerCase()) hit.push(node);
  });
  return hit;
}
