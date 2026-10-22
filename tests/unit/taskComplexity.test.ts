import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PlanningDirective,
  TaskComplexityClassifier,
} from '../../src/core/planning/taskComplexityClassifier.ts';

test('复杂度分类：简单问题不触发规划（避免误伤）', () => {
  assert.strictEqual(TaskComplexityClassifier.assess('解释一下这个函数').complex, false);
  assert.strictEqual(TaskComplexityClassifier.assess('hi').complex, false);
});

test('复杂度分类：长任务/多文件/多阶段/用户列步骤触发', () => {
  assert.strictEqual(
    TaskComplexityClassifier.assess(`请实现一个新功能并修复相关测试：${'细节。'.repeat(80)}`)
      .complex,
    true,
  );
  assert.strictEqual(
    TaskComplexityClassifier.assess('修改 src/a.ts 和 src/b.ts 并跑测试').complex,
    true,
  );
  assert.strictEqual(
    TaskComplexityClassifier.assess('先读代码，然后修改实现，接着跑测试，最后总结').complex,
    true,
  );
  assert.strictEqual(
    TaskComplexityClassifier.assess('步骤：\n1. 读代码\n2. 修改\n3. 测试').complex,
    true,
  );
});

test('规划要求文本必须指向 todo_write 且不可跳过', () => {
  const text = PlanningDirective.text({
    complex: true,
    score: 2,
    reasons: ['多文件'],
  });
  assert.match(text, /todo_write/u);
  assert.match(text, /第一步/u);
  assert.match(text, /不要跳过规划/u);
});
