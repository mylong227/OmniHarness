/**
 * 工作区身份归一判据（2026-10-07 用户报「会话没有按所属项目归类 / 切了新项目还显示旧项目的会话」）。
 *
 * 真机数据（本机 1249 条会话的 `session_meta.payload.workspace` 分组）：同一个项目被写成
 * `D:\deepseek\omniharness`（587）、`D:/deepseek/omniharness`（155）与
 * `D:\deepseek\omniharness\.omniharness\model-test-runs\run-…\m1-…`（各 1）等多种拼写，
 * 而归档过滤此前是**字面量相等** ⇒ 一个项目裂成好几个、另一个项目下混进别家会话。
 *
 * 判据钉两件事：① 三种拼写必须归一到同一个身份；② 自动化跑测子目录必须折叠回宿主项目
 * （否则侧栏会冒出十几个"项目"）；③ 空标记保持"无归属"（不许被折叠成 cwd 之类的假项目）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceIdentity } from '../../src/util/workspaceIdentity.js';

describe('WorkspaceIdentity：同一项目的多种拼写必须归一为同一身份', () => {
  it('分隔符 / 盘符大小写 / 尾分隔符 / 重复分隔符', () => {
    const canonical = WorkspaceIdentity.normalize('D:\\deepseek\\omniharness');
    for (const variant of [
      'D:/deepseek/omniharness',
      'd:\\deepseek\\omniharness',
      'D:\\deepseek\\omniharness\\',
      'D:\\\\deepseek\\\\omniharness',
      '  D:\\deepseek\\omniharness  ',
    ]) {
      assert.strictEqual(
        WorkspaceIdentity.normalize(variant),
        canonical,
        `拼写变体必须归一：${variant}`,
      );
    }
  });

  it('自动化跑测在项目内建的工作区折叠回宿主项目', () => {
    const host = WorkspaceIdentity.normalize('D:\\deepseek\\omniharness');
    assert.strictEqual(
      WorkspaceIdentity.normalize(
        'D:\\deepseek\\omniharness\\.omniharness\\model-test-runs\\run-2026-10-06T08-19-06-284Z\\m1-spec-decompose-implement',
      ),
      host,
    );
    assert.strictEqual(
      WorkspaceIdentity.normalize('D:\\deepseek\\omniharness\\.omniharness\\probe-1744045509'),
      host,
    );
  });

  it('不同项目不得被判为同一身份；空标记保持"无归属"', () => {
    assert.strictEqual(WorkspaceIdentity.same('D:\\a\\b', 'D:\\a\\c'), false);
    assert.strictEqual(WorkspaceIdentity.same('D:\\a\\b', 'D:/A/B'), true);
    assert.strictEqual(WorkspaceIdentity.same('', 'D:\\a\\b'), false);
    assert.strictEqual(WorkspaceIdentity.same(undefined, undefined), false);
    assert.strictEqual(WorkspaceIdentity.normalize('   '), '', '空白标记必须归为无归属');
  });
});
