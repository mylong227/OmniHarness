/**
 * **泛型服务令牌**的判据（G26/TS2，2026-10-03 第十三轮）。
 *
 * ## 背景
 *
 * 容器原先 `register(key: string, instance: unknown)` + `get<T>(key: string): T`：**键与值的类型在类型层
 * 毫无关联**——`get<T>` 的 `T` 纯属调用点断言（实现就是 `return value as T`）。于是"把 A 端口注册到 B 键"
 * 与"取用时写错类型"都要到**运行期**才暴露。
 *
 * 本项引入 `ServiceKey<T>` 令牌（实现类在 `core/serviceKey.ts`，端口只给结构契约 `ServiceKeyLike<T>`），
 * 把键与值类型绑在类型层：
 *  - 注册：类型不符 ⇒ **编译失败**；
 *  - 取用：`container.get(ServiceKeys.tools)` **无需显式泛型参数**即得 `ToolPort`。
 *
 * ## 判据怎么覆盖"编译期"这件事
 *
 * 类型层判据用 `@ts-expect-error` 写在**不会执行**的函数里：若类型系统**没有**拦住那行错，
 * `tsc` 会因"未使用的 `@ts-expect-error` 指令"报错 ⇒ 门禁变红。这就是"编译期断言"的可门禁化做法
 * （`npm run typecheck` 是门禁的一部分）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Container } from '../../src/core/container.js';
import { ServiceKey } from '../../src/core/serviceKey.js';
import { ServiceKeys } from '../../src/composition/serviceKeys.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';
import type { ModelPort } from '../../src/ports/model/model.js';

/** 假的工具端口（只为类型与身份比对，不实现任何真实工具语义）。 */
const fakeTools = { name: 'fake-tools' } as unknown as ToolPort;
/** 假的模型端口。 */
const fakeModel = { name: 'fake-model' } as unknown as ModelPort;

/**
 * **类型层判据（不执行）**：若类型系统没拦住任一错误行，`tsc` 会因未使用的 `@ts-expect-error` 而红。
 *
 * 刻意不调用：这里只做类型检查，运行期语义由下面的用例覆盖。
 * @returns 无返回值（永不被调用）。
 */
function typeLevelAssertions(): void {
  const container = new Container();
  container.register(ServiceKeys.tools, fakeTools);
  container.register(ServiceKeys.model, fakeModel);

  // @ts-expect-error 把 ModelPort 注册到 tools 令牌上必须**编译失败**（键与类型已绑定）
  container.register(ServiceKeys.tools, fakeModel);

  // @ts-expect-error 覆盖时同样受检
  container.overwrite(ServiceKeys.tools, fakeModel);

  // @ts-expect-error 自造令牌与标准键不同型 ⇒ 不可互换注册（防止"以为在写 tools、其实写了别的键"）
  container.register(new ServiceKey<ModelPort>('port.tools'), fakeTools);

  // 正例：令牌形态**无需显式泛型参数**即得正确类型（零调用点断言）。
  const tools: ToolPort = container.get(ServiceKeys.tools);
  const model: ModelPort = container.get(ServiceKeys.model);
  void tools;
  void model;
}
void typeLevelAssertions;

test('① 令牌把键与值类型绑定：字符串形态可读、且与历史键名逐字一致（兼容）', () => {
  for (const [key, expected] of [
    [ServiceKeys.model, 'port.model'],
    [ServiceKeys.tools, 'port.tools'],
    [ServiceKeys.storage, 'port.storage'],
    [ServiceKeys.events, 'port.events'],
    [ServiceKeys.sandbox, 'port.sandbox'],
    [ServiceKeys.approvals, 'port.approvals'],
  ] as const) {
    assert.strictEqual(
      key.name,
      expected,
      `令牌名必须与历史字符串键逐字一致，否则既有插件按 '${expected}' 注册/取用会失配`,
    );
    assert.strictEqual(String(key), expected, 'toString() 必须给出键名（便于日志与错误消息）');
  }
});

test('② 令牌与字符串键指向同一桶（同键互操作，插件扩展不受影响）', () => {
  const container = new Container();
  container.register(ServiceKeys.tools, fakeTools);
  assert.strictEqual(container.has(ServiceKeys.tools), true);
  assert.strictEqual(container.has('port.tools'), true, '令牌注册后，字符串形态必须能命中同一个桶');
  assert.strictEqual(
    container.get<ToolPort>('port.tools'),
    fakeTools,
    '字符串取用仍可用（调用点断言形态）',
  );

  const other = new Container();
  other.register('port.tools', fakeTools);
  assert.strictEqual(other.get(ServiceKeys.tools), fakeTools, '字符串注册后，令牌形态也必须能取到');
});

test('③ 运行期语义不变：重名抛错、未注册抛错、覆盖生效', () => {
  const container = new Container();
  container.register(ServiceKeys.tools, fakeTools);
  assert.throws(
    () => container.register(ServiceKeys.tools, fakeTools),
    /服务重复注册/,
    '重名必须抛错',
  );
  assert.throws(() => container.get(ServiceKeys.model), /服务未注册/, '未注册必须抛错');
  assert.strictEqual(container.has('port.nope'), false, 'has 对未注册键必须为 false');
  // 别写成 `has(...) && get(...)`：`has` 返回 false 会**短路**，`get` 根本不执行 ⇒ 判据假绿
  //（本用例首版就是这么写的，运行时报"Missing expected exception"才发现）。
  assert.throws(() => container.get('port.nope'), /服务未注册/, '未注册的字符串键同样必须抛错');

  container.overwrite(ServiceKeys.tools, fakeModel as unknown as ToolPort);
  assert.strictEqual(
    container.get(ServiceKeys.tools),
    fakeModel as unknown as ToolPort,
    '覆盖应生效',
  );
});

test('④ 令牌类是 core 侧普通对象（仅一个 name 字段）：运行期不携带类型烙印', () => {
  const key = new ServiceKey<ToolPort>('port.x');
  assert.deepStrictEqual(
    Object.keys(key),
    ['name'],
    '类型烙印必须是 `declare`（不产生运行期字段）',
  );
  assert.strictEqual('__serviceType' in key, false, '烙印只存在于类型层');
  assert.strictEqual(key.name, 'port.x');
});
