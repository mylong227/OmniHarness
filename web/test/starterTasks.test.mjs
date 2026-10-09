// 空态「快速开始」示例任务的判据（2026-10-08 易用性轮）。
//
// ## 被改的形态（真机截图取证）
//
// 新客户打开工作台，中栏只有：
//
//   等待任务
//   下达任务后，模型推理、工具调用与结果将在此实时呈现。
//
// 这句话只说了"这里会发生什么"，**没说"我该输入什么"**。学习成本的最大来源不是功能复杂，
// 而是第一句话不知道怎么写。
//
// ## 判据
//
// | # | 判据 | 反例形态（改了就会红） |
// |---|------|------------------------|
// | ① | 每条示例都能**直接发送**（无 `{占位符}`），且长度可控 | 写成「读取 `{文件名}`」⇒ 客户还得猜语法 |
// | ② | 四条覆盖 read / shell / search / write 四条通路 | 被改成四条同质示例（都只是"读文件"） |
// | ③ | 文案用客户语言，不出现内部工具名（`read_file` / `shell` / `search_files`） | 把内部术语摆到第一屏 |
// | ④ | 点击是**填进输入框**（`seedDraft`），不是直接发送（`onSend`） | 接成 onSend ⇒ 第一次点按钮就消耗真实额度 |
// | ⑤ | `seedDraft` 行为：空文本 fail-closed、nonce 单调递增（连点同一示例也能回填） | 不递增 nonce ⇒ 第二次点同一个示例没反应 |

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './hooksStub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');

// deps.js 在模块顶层读 window，须先种零 DOM 桩（与 controllerBindings.test.mjs 同一口径）。
createRuntime().install();
const { StarterTasks } = await import('../dist/ui/models/StarterTasks.js');
const { ComposerController } = await import('../dist/ui/controllers/ComposerController.js');

test('① 每条示例都能直接发送（无占位符）且长度可控', () => {
  const items = StarterTasks.list();
  assert.ok(items.length >= 3, `示例太少（${items.length} 条）`);
  for (const t of items) {
    assert.ok(t.label.trim() !== '', '标签不得为空');
    assert.ok(t.prompt.trim() !== '', `示例「${t.label}」的任务描述不得为空`);
    // 「能直接发送」= 没有留给用户的占位符语法
    assert.ok(
      !/[{<[]\s*(文件名|路径|目录|file|path|TODO|\.\.\.)\s*[}>\]}]/i.test(t.prompt),
      `示例「${t.label}」含未填占位符 ⇒ 客户还得猜格式：${t.prompt}`,
    );
    assert.ok(t.prompt.length <= 160, `示例「${t.label}」过长（${t.prompt.length} 字），第一屏读不完`);
  }
  // 标签唯一（React key + 客户不会看到两个同名入口）
  const labels = items.map((t) => t.label);
  assert.deepStrictEqual([...new Set(labels)], labels, `示例标签必须唯一：${labels.join(' / ')}`);
  // 顺序稳定（同一进程内两次调用必须是同一份，防被改成"每次随机挑"）
  assert.deepStrictEqual(
    StarterTasks.list().map((t) => t.label),
    labels,
    '示例清单必须稳定',
  );
});

test('② 四条覆盖 read / shell / search / write 四条核心通路', () => {
  const joined = StarterTasks.list()
    .map((t) => `${t.label} ${t.prompt}`)
    .join('\n');
  // 每条通路各有一个「可识别的动作词」——防示例被改成四条同质内容（那样等于只教了一个能力）
  const paths = [
    ['读文件', /读取|读一下|总结|摘要/],
    ['跑命令', /运行命令|运行 `|执行命令|跑/],
    ['搜索', /搜索|查找|找一下/],
    ['写代码', /新建|创建|写入|生成/],
  ];
  for (const [name, re] of paths) {
    assert.match(joined, re, `示例未覆盖「${name}」这条通路（入门示例必须展示能力面宽度）`);
  }
});

test('③ 文案用客户语言：不得把内部工具名摆到第一屏', () => {
  const joined = StarterTasks.list()
    .map((t) => `${t.label} ${t.prompt}`)
    .join('\n');
  for (const term of ['read_file', 'write_file', 'shell', 'search_files', 'apply_patch', 'list_dir']) {
    assert.ok(!joined.includes(term), `第一屏出现了内部工具名「${term}」：学习成本应当由产品承担，不是客户`);
  }
});

test('④ 接线：点击是「填进输入框」（seedDraft），不是直接发送（onSend）', () => {
  const app = readFileSync(join(WEB_ROOT, 'src', 'ui', 'App.ts'), 'utf8');
  assert.match(app, /onUseStarter:\s*ctrl\.composer\.seedDraft/, 'App 必须把示例接到 seedDraft（填入而非发送）');
  const view = readFileSync(join(WEB_ROOT, 'src', 'ui', 'components', 'StreamView.tsx'), 'utf8');
  assert.match(view, /StarterTasks\.list\(\)/, '空态必须渲染示例清单');
  assert.match(view, /onClick=\{\(\) => onUseStarter\(t\.prompt\)\}/, '点击必须把示例文本交给回填回调');
  // 关键反向约束：示例按钮**不得**直接调用 onSend（否则第一次点按钮就消耗真实额度）
  const starterBlock = view.slice(view.indexOf('starter-tasks'), view.indexOf('stream-inner'));
  assert.ok(
    !/onSend\s*\(/.test(starterBlock),
    '示例按钮不得直接 onSend：第一次点按钮就花钱，对客户是惊吓不是引导',
  );
  // 图标必须在 Icon.ts 里登记过（未登记的图标会渲染成空白格）
  const icons = readFileSync(join(WEB_ROOT, 'src', 'ui', 'models', 'Icon.ts'), 'utf8');
  for (const t of StarterTasks.list()) {
    assert.match(icons, new RegExp(`^\\s{2}'?${t.icon}'?:\\s*\\{`, 'm'), `图标「${t.icon}」未在 Icon.ts 登记`);
  }
});

test('⑤ seedDraft 行为：空文本 fail-closed、nonce 单调递增（连点同一示例也能回填）', () => {
  const toasts = [];
  const state = { composerSeed: null };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const services = { api: {}, toast: (message, kind) => toasts.push([message, kind]) };
  // 第三参 sessions 只在 send 路径用得上，本判据不碰
  const ctrl = new ComposerController(host, services, /** @type {never} */ ({}));

  ctrl.seedDraft('读一下 README.md');
  assert.equal(state.composerSeed.text, '读一下 README.md');
  assert.equal(state.composerSeed.nonce, 1, '首次回填 nonce 必须为 1');
  // 连点**同一个**示例：文本相同，靠 nonce 递增触发新一次回填（否则 Composer 不响应）
  ctrl.seedDraft('读一下 README.md');
  assert.equal(state.composerSeed.nonce, 2, '同文本再次回填必须递增 nonce');
  ctrl.seedDraft('  另一个示例  ');
  assert.equal(state.composerSeed.text, '另一个示例', '必须 trim');
  assert.equal(state.composerSeed.nonce, 3);
  // 空文本 fail-closed：不写状态（否则"点了没反应"且查不出原因），并给出可读提示
  const before = { ...state.composerSeed };
  ctrl.seedDraft('   ');
  assert.deepStrictEqual(state.composerSeed, before, '空文本不得改写回填状态');
  assert.equal(toasts.length, 1, '空文本必须给出一次提示');
  assert.equal(toasts[0][1], 'err');
  // 脱离实例调用（裸引用传给子组件时 this 不能丢——见 controllerBindings.test.mjs 的事故形态）
  const detached = ctrl.seedDraft;
  detached('脱离实例调用');
  assert.equal(state.composerSeed.text, '脱离实例调用', '裸引用调用必须仍然到达 host');
});
