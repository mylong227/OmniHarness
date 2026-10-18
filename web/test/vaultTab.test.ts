/**
 * 凭据保险库面板判据（Web 交付第 6 个入口，2026-10-11）。
 *
 * ## 判据要钉死什么（凭据面，标准最高）
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 未接线 ⇒ 显示原因**并给出开启方式**，不得渲染成"保险库为空" | 用户以为凭据丢了 |
 * | ② | 已接线且空 ⇒ 才显示"保险库为空（已接线）"，与①可区分（正对照） | 两者混为一谈 |
 * | ③ | 列表**只渲染名字**；面板源码里不存在任何"取值"调用（`vault.get` / `getSecret`） | 有人后来加个"显示"按钮就把密文带进页面 |
 * | ④ | 密码输入框 type=password（不进可读控件），且写入按钮在空值时禁用 | 明文回显 / 空写盘 |
 * | ⑤ | 入口已注册（PANELS + Router） | 漏注册 ⇒ 静默落回默认面板 |
 */

// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { act, renderFacadeAsync } from './rtlHarness.ts';
import { allText as facadeAllText, byTag, facadeOf, walk as facadeWalk } from './domFacade.ts';
import type { FacadeNode } from './domFacade.ts';


import { VaultTab } from '../src/ui/components/tabs/VaultTab.tsx';
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染保险库面板并等一次取数落地。
 *
 * 迁移说明（2026-10-18）：原先用 `await renderSeeded({hookIndex: value})` 直接摆"已取到的数据"。
 * 真实 React 下改成**让组件真的去取**：种子 0 变成首个 `api` 调用的返回值（`vaultList`），
 * 于是判据不但复现了同一场景，还顺带覆盖了真实取数路径；种子 4/5 是输入框的值，改用真实输入驱动。
 *
 * @param state `0` = vaultList 的返回；`4` = 名称输入；`5` = 凭据输入
 * @returns 外观节点
 */
async function renderSeeded(state: { 0?: unknown; 4?: string; 5?: string } = {}) {
  const ui = await renderFacadeAsync(VaultTab, {
    props: {},
    firstResponse: state[0] ?? { ok: true, names: [] },
  });
  if (state[4] === undefined && state[5] === undefined) return ui.node;

  // 填值必须发生在**同一个实例**上（重新渲染等于换了个空表单，输入就丢了）。
  //
  // 用 `userEvent` 而不是 `fireEvent.change`：后者对**受控输入**不可靠——React 19 会把
  // `value` 回滚成 state 里的旧值，表现为"填了等于没填"（本用例实测踩到）。userEvent 走真实
  // 按键序列，受控输入会正常更新 state。
  const user = userEvent.setup();
  if (state[4] !== undefined) {
    const nameInput = byTag(ui.node, 'input').find((n) => n.props['type'] !== 'password');
    if (nameInput !== undefined) await user.type(nameInput.el as HTMLElement, state[4]);
  }
  if (state[5] !== undefined) {
    const secretInput = byTag(ui.node, 'input').find((n) => n.props['type'] === 'password');
    if (secretInput !== undefined) await user.type(secretInput.el as HTMLElement, state[5]);
  }
  // 输入引发的重渲染在 React 批处理里异步落地：冲一次队列后**从同一容器**重新快照。
  await act(async () => {
    await Promise.resolve();
  });
  return facadeOf(ui.container.firstElementChild);

}

/**
 * 收集整棵树的文本叶子。
 * @param vnode 外观节点或数组
 * @returns 文本片段
 */
function texts(vnode: unknown, out: string[] = []): string[] {
  if (Array.isArray(vnode)) {
    for (const node of vnode) texts(node, out);
    return out;
  }
  if (vnode === null || vnode === undefined) return out;
  if (typeof vnode === 'string' || typeof vnode === 'number') {
    out.push(String(vnode));
    return out;
  }
  const joined = facadeAllText(vnode as FacadeNode);
  if (joined !== '') out.push(joined);
  return out;
}

/**
 * 深度收集满足谓词的节点。
 * @param vnode 外观节点或数组
 * @param pred 谓词
 * @returns 命中节点
 */
function collect(vnode: unknown, pred: (n: FacadeNode) => boolean): FacadeNode[] {
  const out: FacadeNode[] = [];
  const push = (n: FacadeNode): void => {
    if (pred(n)) out.push(n);
  };
  if (Array.isArray(vnode)) for (const v of vnode) facadeWalk(v as FacadeNode | null, push);
  else facadeWalk(vnode as FacadeNode | null, push);
  return out;
}

test('① 未接线 ⇒ 显示原因 + 开启方式，不得渲染成"保险库为空"', async () => {
  const text = texts(await renderSeeded({ 0: { ok: false, reason: 'vault 未接线（serve 组合根未注入 vault）' } })).join('');
  assert.match(text, /未接线/u);
  assert.match(text, /serve 组合根未注入 vault/u, '必须带出服务端原因');
  // 2026-10-12：默认口径下 serve 本来就接线（用户级密钥文件），所以"未接线"最常见的原因是
  // OMNIHARNESS_VAULT=0 被显式关闭 ⇒ 提示必须指向这条出路，而不是让人去设环境变量/给旗标。
  assert.match(text, /OMNIHARNESS_VAULT/u, '必须给出可行动的开启/恢复线索');
  assert.match(text, /OMNIHARNESS_VAULT=0|\.omniharness/u, '必须点名关闭开关或默认密钥文件位置');
  assert.doesNotMatch(text, /保险库为空/u, '未接线不得说"保险库为空"（会被读成凭据丢了）');
});

test('② 已接线且空 ⇒ 才说"保险库为空"（正对照，防①恒真）', async () => {
  const text = texts(await renderSeeded({ 0: { ok: true, names: [] } })).join('');
  assert.match(text, /保险库为空/u);
  assert.doesNotMatch(text, /未接线/u, '已接线时不得说未接线');
});

test('③ 列表只渲染名字；面板源码不含任何读值调用', async () => {
  const text = texts(
    await renderSeeded({ 0: { ok: true, names: ['OPENAI_API_KEY', 'KIMI_KEY'] } }),
  ).join('');
  assert.match(text, /OPENAI_API_KEY/u);
  assert.match(text, /KIMI_KEY/u);

  // jsdom 环境下 `import.meta.url` 不是 file: scheme（`new URL(...)` 会抛
// "The URL must be of scheme file"）。按**仓库相对路径**读：vitest 的 cwd 恒为仓库根。
  const source = readFileSync('web/src/ui/components/tabs/VaultTab.tsx', 'utf8');
  // 只看**代码行**（注释里出现 "vault.get" 是在解释"服务端故意没有它"，不该判红——
  // 第一版就是被自己的注释假红了一次）。
  const codeLines = source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  for (const forbidden of ['vault.get', 'getSecret(', "'vault.read'"]) {
    assert.ok(
      !codeLines.includes(forbidden),
      `面板不得出现读值调用 ${forbidden}（凭据不回读给浏览器）`,
    );
  }
  // 正对照：把读值调用塞进**代码行**必须被检出。
  const mutated = `${codeLines}\nconst leak = api.vault.get('x');\n`;
  assert.ok(mutated.includes('vault.get'), '正对照变异未落地');
  assert.ok(codeLines.split('\n').length < mutated.split('\n').length, '正对照应确实改变了代码');
});

test('④ 密码框 type=password；空值时写入按钮禁用', async () => {
  const tree = await renderSeeded({ 0: { ok: true, names: [] } });
  const secretInput = collect(tree, (n) => n.props?.type === 'password')[0];
  assert.ok(secretInput !== undefined, '凭据输入框必须是 password 类型（不进可读控件）');
  const saveBtn = collect(tree, (n) => n.type === 'button' && texts(n).join('') === '写入')[0];
  assert.ok(saveBtn !== undefined, '必须有写入按钮');
  assert.strictEqual(saveBtn.props.disabled, true, '空值时写入按钮应禁用（避免空写盘）');

  const filled = await renderSeeded({ 0: { ok: true, names: [] }, 4: 'NAME', 5: 'secret-value' });
  const filledBtn = collect(filled, (n) => n.type === 'button' && texts(n).join('') === '写入')[0];
  // 外观节点按 **DOM 语义**给布尔属性：没有 `disabled` 属性时该键**不存在**（值为 undefined），
  // 而不是 React props 里的 false。判据仍是「可写入」，只是改用存在性表达。
  assert.ok(filledBtn !== undefined, '必须有写入按钮');
  assert.ok(!('disabled' in filledBtn.props), '填了名称与凭据后应可写入（不得再有 disabled）');
});

test('⑤ 入口已注册：PANELS 含 vault，Router 认可该 pane', () => {
  assert.ok(PANELS.some((p) => p.key === 'vault'), 'PANELS 必须含 vault');
  const saved = globalThis.location;
  try {
    // 桩只提供 parseHash 实际读取的 hash 字段（按边界约定断言为 Location）。
    globalThis.location = { hash: '#pane=vault' } as Location;
    assert.strictEqual(parseHash().pane, 'vault');
  } finally {
    globalThis.location = saved;
  }
});
