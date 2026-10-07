// 控制器「方法绑定」门禁：防止「方法当裸引用传给子组件却忘了绑定」这类**静默失效**复发。
//
// ## 缺陷形态（2026-09-27 用户报「会话删除无效」的实测根因）
//
// `App.ts` 以**裸引用**把控制器方法传给子组件：`onDelete: ctrl.sessions.deleteSession`、
// `onToggleTheme: ctrl.layout.toggleTheme`、`onSelect: ctrl.sessions.loadThread` …
// 裸引用调用时 `this` 丢失，而这些方法都要用 `this.host` / `this.services`，于是：
//   · 同步方法 ⇒ 事件处理器里抛 TypeError：按钮点了毫无反应（只在控制台留一行）；
//   · **async** 方法 ⇒ 静默 unhandledRejection。
// 实测后果：点「删除」后 storage 里的 `.jsonl` 仍在、列表不变、界面**没有任何提示**；
// 页面只留下 `rejection: Cannot read properties of undefined (reading 'services')`。
// 当时各控制器用手写绑定清单，已漂过两处：`SessionController` 漏 `renameSession` / `deleteSession` /
// `forkSession`，`LayoutController` 整类 0 绑定。
//
// ## 本门禁的两条判据
//
// ① **接线**（源码级）：`App.ts` 里以裸引用传出的那些方法所属的控制器，必须统一走
//    `MethodBinder.bindAll(this)`——手写清单会再漂，故不再接受清单式绑定；
// ② **行为**（运行级）：真造实例，把方法**脱离实例**调用（`const f = ctrl.deleteSession; await f(id)`），
//    断言它真的到达 api / host —— 这条在修复前必红。
//
// 直跑：node web/test/controllerBindings.test.mjs（需先 npm run web:build）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './hooksStub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..');
const APP_TS = join(WEB_ROOT, 'src', 'ui', 'App.ts');
const CONTROLLERS_DIR = join(WEB_ROOT, 'src', 'ui', 'controllers');

// `App.ts` 的分组别名 → 控制器源文件（与 AppController 的 get 访问器一一对应）。
const GROUPS = {
  sessions: 'SessionController.ts',
  composer: 'ComposerController.ts',
  graph: 'GraphController.ts',
  files: 'FileController.ts',
  layout: 'LayoutController.ts',
};

// deps.js 在模块顶层读 window，须先种零 DOM 桩（与 streamThrottleWiring.test.mjs 同一口径）。
createRuntime().install();
const { SessionController } = await import('../dist/ui/controllers/SessionController.js');
const { LayoutController } = await import('../dist/ui/controllers/LayoutController.js');

/**
 * 取出 App.ts 里以**裸引用**（后面不跟 `(`）传出的控制器方法名。
 * @returns {{group: string, method: string}[]} 裸引用清单。
 */
function nakedReferences() {
  const src = readFileSync(APP_TS, 'utf8');
  const out = [];
  const re = /ctrl\.([A-Za-z]+)\.([A-Za-z]+)(\s*\()?/g;
  for (const m of src.matchAll(re)) {
    const [, group, method, called] = m;
    if (called !== undefined) continue; // `ctrl.x.y(...)` 是实例调用，天然有 this
    out.push({ group, method });
  }
  return out;
}

test('① 接线：App.ts 里裸引用传出的控制器，必须统一 MethodBinder.bindAll（不接受手写清单）', () => {
  const refs = nakedReferences();
  assert.ok(refs.length > 0, '未从 App.ts 解析到任何裸引用（解析口径可能过期了）');
  const groups = [...new Set(refs.map((r) => r.group))];
  for (const group of groups) {
    const file = GROUPS[group];
    assert.ok(file !== undefined, `App.ts 引用了未知分组 ctrl.${group}（请同步本测试的分组表）`);
    const src = readFileSync(join(CONTROLLERS_DIR, file), 'utf8');
    assert.match(
      src,
      /MethodBinder\.bindAll\(this\)/,
      `${file} 必须调用 MethodBinder.bindAll(this)：裸引用传出方法时手写绑定清单已经漂过，别再用清单`,
    );
  }
});

test('② 行为：会话控制器的删除/改名/复制脱离实例调用也必须到达 api（修复前 here 抛 this 丢失）', async () => {
  const calls = [];
  const sessions = [{ id: 's1', label: 'l', workspace: 'w', updatedAt: '', turns: 1, running: false }];
  const services = {
    api: {
      deleteSession: async (id) => {
        calls.push(['delete', id]);
        return { ok: true };
      },
      renameSession: async (id, title) => {
        calls.push(['rename', id, title]);
        return { ok: true };
      },
      forkSession: async (id) => {
        calls.push(['fork', id]);
        return { ok: true };
      },
      listSessions: async () => ({ sessions }),
    },
    toast: (message) => calls.push(['toast', message]),
    reducers: {
      ingestEvent: (s) => s,
      mergeToolResult: (t) => t,
      mergeToolInput: (i) => i,
      appendTextDelta: (p, t) => p + t,
      mergeSessions: (prev) => prev,
    },
  };
  const state = { currentThreadId: null, sessions, events: [], toolResults: {}, liveInputs: [], streamText: '' };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const ctrl = new SessionController(host, services);

  // 脱离实例调用（等价于把裸引用交给子组件后由它调用）。
  const del = ctrl.deleteSession;
  const ren = ctrl.renameSession;
  const fork = ctrl.forkSession;
  await del('s1');
  await ren('s1', '新标题');
  await fork('s1');

  assert.deepStrictEqual(
    calls.filter((c) => c[0] !== 'toast'),
    [
      ['delete', 's1'],
      ['rename', 's1', '新标题'],
      ['fork', 's1'],
    ],
    '三个方法都必须真的到达 api（`this` 丢失时它们会静默失败）',
  );
});

test('②-b 行为：文件控制器的 openFile 脱离实例调用也必须到达 api 并写回视图（async 裸引用高危类）', async () => {
  const calls = [];
  const services = {
    api: {
      readFs: async (path) => {
        calls.push(['readFs', path]);
        return { path, content: 'export {}', size: 10, isBinary: false, truncated: false };
      },
    },
    toast: (message) => calls.push(['toast', message]),
    navigate: (partial) => calls.push(['navigate', partial.pane]),
    reducers: {},
  };
  const state = { fileView: null, openFiles: [], activePane: 'tools' };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const { FileController } = await import('../dist/ui/controllers/FileController.js');
  const ctrl = new FileController(host, services);
  const openFile = ctrl.openFile; // 脱离实例（等价于把裸引用交给子组件后由它调用）
  await openFile('src/a.ts');

  assert.deepStrictEqual(calls[0], ['readFs', 'src/a.ts'], '必须真的到达 api.readFs');
  assert.strictEqual(state.fileView.title, 'src/a.ts', '读取结果必须写回 fileView');
  assert.strictEqual(state.openFiles.length, 1, '文件标签集合必须收入新文件');
  assert.ok(calls.some((c) => c[0] === 'navigate' && c[1] === 'file'), '必须路由到 file 面板');
});

test('③ 行为：布局控制器的主题/抽屉切换脱离实例调用也必须改到宿主状态', () => {
  // `toggleTheme` 会写 `document.documentElement` 的 data-theme；本文件是零 DOM 环境，
  // 故只补最小桩（写属性即可），不引入 jsdom。
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { setAttribute() {} } };
  try {
    const patches = [];
    const state = { theme: 'dark', leftOpen: true, rightOpen: false, leftWidth: 300, rightWidth: 320 };
    const host = {
      patch(action) {
        const next = typeof action === 'function' ? action(state) : action;
        patches.push(next);
        Object.assign(state, next);
      },
      getState: () => state,
    };
    const layout = new LayoutController(host);
    const toggleTheme = layout.toggleTheme;
    const toggleLeft = layout.toggleLeft;
    toggleTheme();
    toggleLeft();
    assert.ok(
      patches.some((p) => p.theme === 'light'),
      '主题切换必须生效（裸引用调用时 `this.host` 读取失败，点了没反应）',
    );
    assert.ok(
      patches.some((p) => p.leftOpen === false),
      '抽屉开合必须生效',
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('④ 结构：控制器的公共方法全部被绑定到实例自身（新增方法自动纳入）', () => {
  const state = { currentThreadId: null, sessions: [], events: [], toolResults: {}, liveInputs: [], streamText: '' };
  const host = {
    patch(action) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const services = {
    api: {},
    toast: () => {},
    reducers: {
      ingestEvent: (s) => s,
      mergeToolResult: (t) => t,
      mergeToolInput: (i) => i,
      appendTextDelta: (p, t) => p + t,
      mergeSessions: (prev) => prev,
    },
  };
  for (const [label, ctor, args] of [
    ['SessionController', SessionController, [host, services]],
    ['LayoutController', LayoutController, [host]],
  ]) {
    const instance = new ctor(...args);
    const proto = Object.getPrototypeOf(instance);
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && typeof Object.getOwnPropertyDescriptor(proto, n)?.value === 'function',
    );
    assert.ok(methods.length > 0, `${label} 未解析到任何原型方法`);
    for (const name of methods) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(instance, name),
        `${label}.${name} 未被绑定：裸引用传出时 this 会丢失`,
      );
    }
  }
});
