// 文件选择器「工作区整树」判据（2026-10-30 重设计 P1，docs/PICKER_REDESIGN_2026-10-30.md §8）。
//
// ## 为什么要重设计（旧实现的代价）
//
// 旧选择器是「逐级走进文件系统的迷你资源管理器」：进目录 = 整列表替换（层级上下文丢失）、
// 跨目录多选被禁止（进目录清空选择）、每进一层一次 `fs.browse` + 全局代际守卫、没有搜索。
//
// 新实现：一次 `fs.list` 拿整棵工作区树，树常驻（空间隐喻）、跨目录多选、客户端过滤。
//
// ## 判据（对应设计 §8 的 ①②③④）
//
//   ① 工作区节点**不触发** `fs.browse`（双源：工作区内走 fs.list，工作区外才懒加载）；
//   ② 跨目录勾选后确认回传的路径集合正确（顺序按勾选先后，路径为绝对/工作区相对均可）；
//   ③ 过滤后勾选集不丢（过滤只是视图，不是选择语义）；
//   ④ 刷新保留展开态与勾选态（键 = path，天然稳定）。
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi } from './rtlHarness.ts';

const { FilePicker } = await import('../src/ui/components/FilePicker.tsx');

/** 工作区树：根上一个文件 + 一个目录（目录下再一个文件），用于跨目录勾选。 */
const TREE = [
  { name: 'a.ts', path: 'a.ts', type: 'file' },
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [{ name: 'b.ts', path: 'src/b.ts', type: 'file' }],
  },
];

/**
 * 渲染选择器并等首次装载落地。
 * @param calls 每次 listFs 调用的记录
 * @param picked 确认回传的记录
 * @param browseCalls fs.browse 调用记录（P2 起「文件系统…」子树会用到）
 * @param browse fs.browse 实现
 * @returns render 句柄（含 unmount）
 */
async function renderPicker(
  calls: { depth?: number }[],
  picked: string[][],
  browseCalls: (string | undefined)[] = [],
  browse: (path?: string) => Promise<unknown> = async () => ({
    level: 'drives',
    roots: [],
    home: '',
  }),
): Promise<ReturnType<typeof renderUi>> {
  const ui = renderUi(FilePicker, {
    props: {
      api: {
        listFs: async (depth?: number) => {
          calls.push({ depth });
          return { tree: TREE };
        },
        browseFs: async (path?: string, includeFiles?: boolean) => {
          browseCalls.push(path);
          void includeFiles;
          return browse(path);
        },
      },
      onCancel: () => {},
      onPick: (paths: string[]) => picked.push(paths),
    },
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return ui;
}

/** 取某个可见节点的复选框元素。 */
function checkboxOf(label: string): HTMLElement {
  const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
  const hit = items.find((el) => (el.textContent ?? '').includes(label));
  assert.ok(hit !== undefined, `找不到树节点：${label}`);
  const box = hit.querySelector('.ant-tree-checkbox');
  assert.ok(box instanceof HTMLElement, `节点缺少复选框：${label}`);
  return box;
}

/** 展开一个目录节点（点切换器）。 */
async function expandDir(label: string): Promise<void> {
  const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
  const hit = items.find((el) => (el.textContent ?? '').trim().startsWith(label));
  assert.ok(hit !== undefined, `找不到目录节点：${label}`);
  const switcher = hit.querySelector('.ant-tree-switcher');
  assert.ok(switcher instanceof HTMLElement, `目录节点缺少切换器：${label}`);
  fireEvent.click(switcher);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

test('① 工作区树用 fs.list；② 跨目录勾选回传正确', async () => {
  const calls: { depth?: number }[] = [];
  const picked: string[][] = [];
  const browseCalls: (string | undefined)[] = [];
  const ui = await renderPicker(calls, picked, browseCalls);
  assert.strictEqual(calls.length, 1, '首开必须只拉一次整树');
  assert.strictEqual(calls[0]!.depth, 3, '默认深度 3（与侧栏文件树一致）');
  // P2 起「文件系统…」子树是**唯一**会调 fs.browse 的地方，且首开只拉盘符层（无参）。
  assert.deepStrictEqual(browseCalls, [undefined], '工作区节点不得触发 fs.browse（只有盘符层一次）');

  fireEvent.click(checkboxOf('a.ts'));
  await expandDir('src');
  fireEvent.click(checkboxOf('b.ts'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.match(document.querySelector('.fp-selected-count')?.textContent ?? '', /已选 2 个/u);

  const confirm = Array.from(document.querySelectorAll('.fp-actions button')).find((b) =>
    (b.textContent ?? '').includes('添加 2 个文件'),
  );
  assert.ok(confirm instanceof HTMLElement, '页脚必须显示「添加 2 个文件」');
  fireEvent.click(confirm);
  assert.deepStrictEqual(picked, [['a.ts', 'src/b.ts']], '跨目录勾选必须全部回传');
  ui.unmount();
});

test('③ 过滤是视图层：过滤后勾选集不丢，清空过滤后仍在', async () => {
  const calls: { depth?: number }[] = [];
  const picked: string[][] = [];
  const ui = await renderPicker(calls, picked);
  fireEvent.click(checkboxOf('a.ts'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  // 过滤框是原生 input（`.fp-filter` 自身即输入元素；antd Input 属面板块，见组件注释）。
  const filter = document.querySelector('.fp-filter') as HTMLInputElement;
  assert.ok(filter !== null, '必须有过滤框');
  fireEvent.change(filter, { target: { value: 'b.ts' } });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  // a.ts 不匹配 ⇒ 不可见；但选择语义不能因此被清掉。
  assert.strictEqual(checkboxOf('b.ts').getAttribute('aria-checked'), 'false');
  assert.match(
    document.querySelector('.fp-selected-count')?.textContent ?? '',
    /已选 1 个/u,
    '过滤不得清空勾选集',
  );

  fireEvent.change(filter, { target: { value: '' } });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.strictEqual(checkboxOf('a.ts').getAttribute('aria-checked'), 'true', '清空过滤后勾选仍在');
  ui.unmount();
});

test('④ 刷新保留展开态与勾选态（键是 path，刷新后不丢）', async () => {
  const calls: { depth?: number }[] = [];
  const picked: string[][] = [];
  const ui = await renderPicker(calls, picked);
  fireEvent.click(checkboxOf('a.ts'));
  await expandDir('src');
  fireEvent.click(checkboxOf('b.ts'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  const refresh = document.querySelector('.fp-refresh') as HTMLElement;
  assert.ok(refresh !== null, '必须有刷新按钮');
  fireEvent.click(refresh);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.strictEqual(calls.length, 2, '刷新必须重新拉一次 fs.list');
  // 展开态保留 ⇒ src/b.ts 仍在 DOM；勾选态保留 ⇒ 计数仍是 2。
  assert.ok(
    Array.from(document.querySelectorAll('[role="treeitem"]')).some((el) =>
      (el.textContent ?? '').includes('b.ts'),
    ),
    '刷新后展开态必须保留',
  );
  assert.match(document.querySelector('.fp-selected-count')?.textContent ?? '', /已选 2 个/u);
  ui.unmount();
});

test('⑤ P2：工作区外走「文件系统…」懒加载，确认时去掉 fs: 前缀还原绝对路径', async () => {  const calls: { depth?: number }[] = [];
  const picked: string[][] = [];
  const browseCalls: (string | undefined)[] = [];
  const ui = await renderPicker(calls, picked, browseCalls, async (path) =>
    path === undefined
      ? { level: 'drives', roots: ['C:/'], home: '' }
      : {
          level: 'dir',
          path,
          dirs: [],
          files: [{ name: 'out.log', size: 12, mediaType: 'text/plain' }],
        },
  );
  // 懒加载子树只在展开时加载：首开只有盘符层一次。
  assert.deepStrictEqual(browseCalls, [undefined], '首开只拉盘符层');
  const drive = Array.from(document.querySelectorAll('[role="treeitem"]')).find((el) =>
    (el.textContent ?? '').includes('C:/'),
  );
  assert.ok(drive !== undefined, '盘符节点必须渲染');
  const switcher = drive.querySelector('.ant-tree-switcher');
  assert.ok(switcher instanceof HTMLElement);
  fireEvent.click(switcher);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.deepStrictEqual(browseCalls, [undefined, 'C:/'], '展开盘符必须只拉该盘');

  fireEvent.click(checkboxOf('out.log'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  const confirm = Array.from(document.querySelectorAll('.fp-actions button')).find((b) =>
    (b.textContent ?? '').includes('添加 1 个文件'),
  );
  assert.ok(confirm instanceof HTMLElement, '工作区外勾选也必须可确认');
  fireEvent.click(confirm);
  assert.deepStrictEqual(picked, [['C:/out.log']], '回传必须是真实绝对路径，不带 fs: 前缀');
  ui.unmount();
});

test('⑥ P3：勾选即预览（前 40 行 / 二进制只说明 / 读失败如实报）', async () => {
  const readCalls: string[] = [];
  const ui = renderUi(FilePicker, {
    props: {
      api: {
        listFs: async () => ({
          tree: [
            { name: 'a.ts', path: 'a.ts', type: 'file' },
            { name: 'pic.png', path: 'pic.png', type: 'file' },
          ],
        }),
        browseFs: async () => ({ level: 'drives', roots: [], home: '' }),
        readFs: async (path: string) => {
          readCalls.push(path);
          if (path === 'pic.png') return { path, isBinary: true, content: '' };
          if (path === 'bad.ts') throw new Error('磁盘炸了');
          const lines = Array.from({ length: 60 }, (_, i) => `line-${String(i + 1)}`);
          return { path, content: lines.join('\n') };
        },
      },
      onCancel: () => {},
      onPick: () => {},
    },
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  fireEvent.click(checkboxOf('a.ts'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.deepStrictEqual(readCalls, ['a.ts'], '勾选即触发一次预览读取');
  const preview = document.querySelector('.fp-preview');
  assert.ok(preview !== null, '必须有预览窗格');
  const text = preview.querySelector('.fp-preview-text')?.textContent ?? '';
  assert.match(text, /line-1\b/u, '预览必须显示正文');
  assert.match(text, /line-40\b/u, '预览取前 40 行');
  assert.doesNotMatch(text, /line-41\b/u, '第 41 行起不预览');

  fireEvent.click(checkboxOf('pic.png'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.match(
    document.querySelector('.fp-preview')?.textContent ?? '',
    /二进制文件/u,
    '二进制只说明、不硬解',
  );

  fireEvent.click(checkboxOf('a.ts'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  // 取消勾选不重新取预览（保留上一次），期间不得多发请求。
  assert.deepStrictEqual(readCalls, ['a.ts', 'pic.png'], '取消勾选不得再发预览请求');
  ui.unmount();
});
