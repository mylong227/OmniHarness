// 控制器「方法绑定」统一入口：把实例的**全部原型方法**绑定到实例自身。
//
// ## 为什么必须有它（2026-09-27 实测的真缺陷）
//
// 控制器方法会以**裸引用**形式传给子组件——`App.ts` 里 `onDelete: ctrl.sessions.deleteSession`、
// `onToggleTheme: ctrl.layout.toggleTheme`、`onSelect: ctrl.sessions.loadThread` ……
// 裸引用被调用时 `this` 丢失，而这些方法全都要用 `this.host` / `this.services`，于是：
//   · **同步**方法 ⇒ 在事件处理器里抛 `TypeError`：按钮点了毫无反应，只在控制台留一行；
//   · **async** 方法 ⇒ 变成**静默 unhandledRejection**（连报错都容易被漏看）。
// 实测后果：在会话列表点「删除」后，storage 里的 `.jsonl` 仍在、列表不变、界面无任何提示；
// 页面里只留下 `rejection: Cannot read properties of undefined (reading 'services')`。
// 用户看到的就是「删除无效」（rename / fork / 主题切换 / 抽屉开合 / 拖拽宽度 同因）。
//
// ## 为什么是「枚举原型」而不是手写绑定清单
//
// 各控制器原先在构造函数里手写 `this.x = this.x.bind(this)`。这份清单**已经漂过**：
// `SessionController` 漏了 `renameSession` / `deleteSession` / `forkSession`，
// `LayoutController` 整类 0 绑定。手写清单在没有门禁时必然再漂，故改为按原型枚举：
// 新增方法自动被绑定，「忘了加进清单」这类缺陷在结构上不可能再出现。
//
// 说明：只绑定**方法**（`descriptor.value` 是函数）。取值器（getter）与 `#private` 成员不在原型方法
// 表里或没有 `value`，会被跳过；`constructor` 也跳过。绑定产生的自有属性会遮蔽原型方法，
// 每个实例多几个闭包，开销可忽略。
/** 控制器实例方法绑定器：把实例的全部原型方法绑定到实例自身（按原型枚举，杜绝手写清单漂移）。 */
export class MethodBinder {
  /**
   * 把实例的全部原型方法绑定到实例自身（幂等：重复调用只是重新绑定同一批方法）。
   * @param instance 目标实例（在各控制器构造函数里传 `this`）。
   * @returns 无返回值。
   */
  public static bindAll(instance: object): void {
    const proto: unknown = Object.getPrototypeOf(instance);
    if (proto === null || typeof proto !== 'object') {
      return;
    }
    const source = proto as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(source)) {
      if (name === 'constructor') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      const value: unknown = descriptor?.value;
      if (typeof value !== 'function') {
        continue;
      }
      Object.assign(instance, { [name]: value.bind(instance) });
    }
  }

  /**
   * 列出实例上**已绑定**的方法名（供门禁/诊断断言「公共方法都已绑定」）。
   * @param instance 目标实例。
   * @returns 已绑定方法名（升序）。
   */
  public static boundNamesOf(instance: object): string[] {
    const names: string[] = [];
    for (const name of Object.getOwnPropertyNames(instance)) {
      const value: unknown = (instance as Record<string, unknown>)[name];
      if (typeof value === 'function') {
        names.push(name);
      }
    }
    return names.sort();
  }
}
