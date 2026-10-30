// 目录选择器「工作区树 + 文件系统懒加载」判据（2026-10-30 重设计 P2，设计 §8 的 ⑤ 与 §4.3）。
//
// ## 判据
//
//   ① 工作区节点来自 `fs.list`，**不触发** `fs.browse`；
//   ② 「文件系统…」展开才加载（`fs.browse()` 列盘符），再展开盘符列子目录 —— 节点级懒加载；
//   ③ 形状不合法（`{}`）⇒ **节点级**错误 + 重试，不卸整页、不把 undefined 灌进 state；
//   ④ 单选目录后确认回传该目录绝对路径；文件节点置灰不可选。
// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { act, fireEvent, renderUi } from './rtlHarness.ts';

const { FolderPicker } = await import('../src/ui/components/FolderPicker.tsx');

/** 工作区树：一个目录 + 一个文件（文件必须置灰）。 */
const WS_TREE = [
  {
    name: 'proj',
    path: 'proj',
    type: 'dir',
    children: [{ name: 'main.ts', path: 'proj/main.ts', type: 'file' }],
  },
];

/** 让 React 消化一次异步（懒加载是 await RPC）。 */
async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** 取某个可见节点（按首行文字）。 */
function nodeOf(label: string): HTMLElement {
  const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
  const hit = items.find((el) => (el.textContent ?? '').includes(label));
  assert.ok(hit !== undefined, `找不到树节点：${label}`);
  return hit as HTMLElement;
}

/**
 * 渲染选择器。
 * @param browseCalls fs.browse 调用记录
 * @param picked 确认回传记录
 * @param browse fs.browse 实现
 * @returns render 句柄
 */
async function renderPicker(
  browseCalls: (string | undefined)[],
  picked: string[],
  browse: (path?: string) => Promise<unknown>,
): Promise<ReturnType<typeof renderUi>> {
  const ui = renderUi(FolderPicker, {
    props: {
      api: {
        listFs: async () => ({ tree: WS_TREE }),
        browseFs: async (path?: string) => {
          browseCalls.push(path);
          return browse(path);
        },
        mkdirFs: async () => ({ path: 'proj/new' }),
      },
      onCancel: () => {},
      onPick: (path: string) => picked.push(path),
    },
  });
  await settle(30);
  return ui;
}

test('① 工作区节点来自 fs.list；② 「文件系统…」展开才按需列盘符', async () => {
  const browseCalls: (string | undefined)[] = [];
  const picked: string[] = [];
  const ui = await renderPicker(browseCalls, picked, async () => ({
    level: 'drives',
    roots: ['C:/', 'D:/'],
    home: 'C:/Users/me',
  }));
  // 工作区节点在树里，且首开只拉了「文件系统…」这一层（undefined = 盘符层）。
  assert.match(nodeOf('proj').textContent ?? '', /proj/u);
  assert.strictEqual(browseCalls.length, 1, '首开只加载「文件系统…」根');
  assert.strictEqual(browseCalls[0], undefined, '盘符层用 fs.browse() 无参');
  assert.match(nodeOf('C:/Users/me').textContent ?? '', /用户目录/u);
  ui.unmount();
});

test('② 展开盘符才拉该盘目录（节点级懒加载，不是一次性全展开）', async () => {
  const browseCalls: (string | undefined)[] = [];
  const picked: string[] = [];
  const ui = await renderPicker(browseCalls, picked, async (path) =>
    path === undefined
      ? { level: 'drives', roots: ['C:/'], home: '' }
      : { level: 'dir', path, dirs: ['work', 'tmp'] },
  );
  const drive = nodeOf('C:/');
  const switcher = drive.querySelector('.ant-tree-switcher');
  assert.ok(switcher instanceof HTMLElement, '盘符节点必须有展开器');
  fireEvent.click(switcher);
  await settle();
  assert.deepStrictEqual(browseCalls, [undefined, 'C:/'], '展开盘符必须只拉该盘');
  assert.match(nodeOf('work').textContent ?? '', /work/u);
  ui.unmount();
});

test('③ 形状不合法 ⇒ 节点级错误 + 重试（不卸整页、不灌 undefined）', async () => {
  const browseCalls: (string | undefined)[] = [];
  const picked: string[] = [];
  let fail = true;
  const ui = await renderPicker(browseCalls, picked, async () => (fail ? {} : { level: 'drives', roots: ['C:/'], home: '' }));
  assert.match(document.body.textContent ?? '', /返回格式异常/u, '非法形状必须如实报错');
  const retry = document.querySelector('.fp-retry');
  assert.ok(retry instanceof HTMLElement, '节点级错误必须带重试');
  fail = false;
  fireEvent.click(retry);
  await settle();
  assert.strictEqual(browseCalls.length, 2, '重试必须再拉一次该节点');
  assert.doesNotMatch(document.body.textContent ?? '', /返回格式异常/u, '重试成功后错误必须消失');
  ui.unmount();
});

test('④ 单选目录后确认回传路径；文件节点置灰不可选', async () => {
  const browseCalls: (string | undefined)[] = [];
  const picked: string[] = [];
  const ui = await renderPicker(browseCalls, picked, async () => ({ level: 'drives', roots: [], home: '' }));
  // 先展开 proj（文件节点是它的子节点）。
  const proj = nodeOf('proj');
  const switcher = proj.querySelector('.ant-tree-switcher');
  assert.ok(switcher instanceof HTMLElement, 'proj 必须有展开器');
  fireEvent.click(switcher);
  await settle();
  // 文件节点 disabled（antd 会标 aria-disabled），点它不得产生选中。
  const file = nodeOf('main.ts');
  assert.strictEqual(file.getAttribute('aria-disabled'), 'true', '文件节点必须置灰');
  fireEvent.click(file.querySelector('.ant-tree-node-content-wrapper') ?? file);
  await settle();
  const confirm = Array.from(document.querySelectorAll('.fp-actions button')).find((b) =>
    (b.textContent ?? '').includes('选择此文件夹'),
  ) as HTMLButtonElement;
  assert.ok(confirm !== undefined);
  assert.strictEqual(confirm.disabled, true, '未选中目录时不得确认');

  fireEvent.click(nodeOf('proj').querySelector('.ant-tree-node-content-wrapper') ?? nodeOf('proj'));
  await settle();
  assert.strictEqual(confirm.disabled, false, '选中目录后可确认');
  fireEvent.click(confirm);
  assert.deepStrictEqual(picked, ['proj'], '必须回传选中目录路径');
  ui.unmount();
});
