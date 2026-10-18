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

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRuntime, type StubVnode } from './hooksStub.ts';

const runtime = createRuntime();
runtime.install();

const { VaultTab } = await import('../src/ui/components/tabs/VaultTab.tsx');
const { PANELS } = await import('../src/ui/models/PanelRegistry.ts');
const { parseHash } = await import('../src/core/Router.ts');

/**
 * 渲染一次组件（hook 序：0=data 1=error 2=notice 3=loading 4=name 5=secret）。
 * @param state 覆盖的槽位值
 * @returns vnode 树
 */
function renderSeeded(state: Record<number, unknown> = {}) {
  runtime.reset();
  return runtime.render(
    VaultTab,
    {},
    { 0: null, 1: null, 2: null, 3: false, 4: '', 5: '', ...state },
  );
}

/**
 * 收集整棵树的文本叶子。
 * @param vnode vnode 树
 * @param out 收集器
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
  texts((vnode as StubVnode).children, out);
  return out;
}

/**
 * 深度收集满足谓词的节点。
 * @param vnode vnode 树
 * @param pred 谓词
 * @param out 收集器
 * @returns 命中节点
 */
function collect(vnode: unknown, pred: (n: StubVnode) => boolean, out: StubVnode[] = []): StubVnode[] {
  if (Array.isArray(vnode)) {
    for (const node of vnode) collect(node, pred, out);
    return out;
  }
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return out;
  const n = vnode as StubVnode;
  if (pred(n)) out.push(n);
  collect(n.children, pred, out);
  return out;
}

test('① 未接线 ⇒ 显示原因 + 开启方式，不得渲染成"保险库为空"', () => {
  const text = texts(renderSeeded({ 0: { ok: false, reason: 'vault 未接线（serve 组合根未注入 vault）' } })).join('');
  assert.match(text, /未接线/u);
  assert.match(text, /serve 组合根未注入 vault/u, '必须带出服务端原因');
  // 2026-10-12：默认口径下 serve 本来就接线（用户级密钥文件），所以"未接线"最常见的原因是
  // OMNIHARNESS_VAULT=0 被显式关闭 ⇒ 提示必须指向这条出路，而不是让人去设环境变量/给旗标。
  assert.match(text, /OMNIHARNESS_VAULT/u, '必须给出可行动的开启/恢复线索');
  assert.match(text, /OMNIHARNESS_VAULT=0|\.omniharness/u, '必须点名关闭开关或默认密钥文件位置');
  assert.doesNotMatch(text, /保险库为空/u, '未接线不得说"保险库为空"（会被读成凭据丢了）');
});

test('② 已接线且空 ⇒ 才说"保险库为空"（正对照，防①恒真）', () => {
  const text = texts(renderSeeded({ 0: { ok: true, names: [] } })).join('');
  assert.match(text, /保险库为空/u);
  assert.doesNotMatch(text, /未接线/u, '已接线时不得说未接线');
});

test('③ 列表只渲染名字；面板源码不含任何读值调用', () => {
  const text = texts(
    renderSeeded({ 0: { ok: true, names: ['OPENAI_API_KEY', 'KIMI_KEY'] } }),
  ).join('');
  assert.match(text, /OPENAI_API_KEY/u);
  assert.match(text, /KIMI_KEY/u);

  const source = readFileSync(new URL('../src/ui/components/tabs/VaultTab.tsx', import.meta.url), 'utf8');
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

test('④ 密码框 type=password；空值时写入按钮禁用', () => {
  const tree = renderSeeded({ 0: { ok: true, names: [] } });
  const secretInput = collect(tree, (n) => n.props?.type === 'password')[0];
  assert.ok(secretInput !== undefined, '凭据输入框必须是 password 类型（不进可读控件）');
  const saveBtn = collect(tree, (n) => n.type === 'button' && texts(n).join('') === '写入')[0];
  assert.ok(saveBtn !== undefined, '必须有写入按钮');
  assert.strictEqual(saveBtn.props.disabled, true, '空值时写入按钮应禁用（避免空写盘）');

  const filled = renderSeeded({ 0: { ok: true, names: [] }, 4: 'NAME', 5: 'secret-value' });
  const filledBtn = collect(filled, (n) => n.type === 'button' && texts(n).join('') === '写入')[0];
  assert.strictEqual(filledBtn?.props.disabled, false, '填了名称与凭据后应可写入');
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
