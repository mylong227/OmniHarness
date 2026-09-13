// 原生阻塞弹窗回归护栏（D4）：web/src 内不得再出现 window.confirm / window.prompt / window.alert。
//
// 为什么用「源码扫描」而不是渲染断言：原生弹窗在零 DOM 测试环境里根本不会被触发，
// 只有扫描调用点才能拦住「以后有人又写回 window.confirm」这类回退。
// 匹配前先剥掉注释，避免文档里提到这些 API 造成假阳性。

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 递归收集 .ts / .tsx 源文件（跳过编译产物）。 */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 剥离块注释与行注释（够用的近似：本项目无字符串里写注释标记的用法）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const NATIVE = /window\s*\.\s*(confirm|prompt|alert)\s*\(/;

test('web/src 内不存在 window.confirm / prompt / alert 调用', () => {
  const offenders = [];
  for (const file of sources(ROOT)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (NATIVE.test(code)) offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [], '原生阻塞弹窗必须改走 DialogService');
});

test('DialogService 是唯一对话框出口，并被 AppController 装配', () => {
  const app = readFileSync(join(ROOT, 'ui/controllers/AppController.ts'), 'utf8');
  assert.match(app, /dialogSvc:\s*new DialogService\(\)/, 'AppController 必须实例化 DialogService');
  assert.match(app, /dialogSvc\.bind\(/, 'mount 时必须把 DialogService 绑到 React 状态');
  assert.match(app, /dialog:\s*this\.services\.dialogSvc/, 'context value 必须暴露 dialog');

  const appComponent = readFileSync(join(ROOT, 'ui/base/AppComponent.tsx'), 'utf8');
  assert.match(appComponent, /get dialog\(\):\s*DialogService/, '组件基类必须提供 dialog 访问器');
});
