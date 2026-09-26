/**
 * 判分执行失败归类器单测（判分可信度：设施层异常不得被记成模型失败）。
 *
 * 现场依据：2026-09-26 实测 django-10097——test_patch 只改数据文件 ⇒ 旧实现把 F2P+P2P
 * 全量 id 转 directive ⇒ 十万字符级 argv ⇒ `spawn ENAMETOOLONG`，落进通用 catch 被记成
 * **模型失败**（污染 resolved 分母、且无法单独重试）。同类错分早前已在 spawn EPERM 上发生过一次。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ExecFailureClassifier } from '../../src/eval/execFailureClassifier.js';

const classifier = new ExecFailureClassifier();

test('环境构建失败前缀 → env（可重试、不进 resolved 分母）', () => {
  const verdict = classifier.classify('ENV_BUILD_FAILED:pytest 未能装入 venv（依赖安装失败）');
  assert.strictEqual(verdict.kind, 'env');
  assert.ok(verdict.message.startsWith('ENV_BUILD_FAILED:'), 'env 分支保留原始原因，不二次包装');
});

test('spawn 系统错误 → env 且原因带「原生执行设施异常」前缀（django-10097 现场）', () => {
  const verdict = classifier.classify('spawn ENAMETOOLONG');
  assert.strictEqual(verdict.kind, 'env');
  assert.ok(verdict.message.includes('原生执行设施异常'));
  assert.ok(verdict.message.includes('ENAMETOOLONG'));
});

test('spawn EPERM / ENOENT 同为设施层（同型错分的历史教训）', () => {
  for (const msg of ['spawn EPERM', 'spawn ENOENT', 'spawn EACCES']) {
    assert.strictEqual(classifier.classify(msg).kind, 'env', `${msg} 应归 env`);
  }
});

test('普通执行异常 → model（不得把模型侧失败洗成设施问题）', () => {
  const verdict = classifier.classify('TypeError: x is not a function');
  assert.strictEqual(verdict.kind, 'model');
  assert.ok(verdict.message.startsWith('原生执行异常: '));
});

test('锚定匹配：文案里出现 "spawn" 但不构成系统错误码时不误判', () => {
  for (const msg of [
    '原生执行异常: spawn 失败：模型补丁语法错误',
    'spawn eperm',
    '容器内 spawn ENOENT 由脚本自身处理',
  ]) {
    assert.strictEqual(classifier.classify(msg).kind, 'model', `${msg} 不应归 env`);
  }
});

test('env 前缀判定是 startsWith：位置不在开头时仍归 model', () => {
  assert.strictEqual(classifier.classify('原生执行异常: ENV_BUILD_FAILED:x').kind, 'model');
});
