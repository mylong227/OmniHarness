import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import type { Skill } from '../../src/skill/skill.js';
import { Agent } from '../../src/core/agent.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';

/** 测试技能。 */
const reviewSkill: Skill = {
  name: 'code-review',
  description: '代码审查',
  instructions: '审查时先查边界条件，再查错误处理。',
  tags: ['审查', 'review'],
};

test('技能注册表：注册与列举', () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  assert.strictEqual(registry.list().length, 1);
  assert.strictEqual(registry.list()[0]?.name, 'code-review');
});

test('技能注册表：重复注册抛错', () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  assert.throws(() => registry.register(reviewSkill), /重复注册/);
});

test('技能注册表：按 tag 命中', () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  assert.strictEqual(registry.match('请帮我审查这段代码').length, 1);
  assert.strictEqual(registry.match('帮我写个函数').length, 0);
});

test('技能注册表：按名称命中', () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  assert.strictEqual(registry.match('用 code-review 技能').length, 1);
});

test('技能渲染：包含名称与指令', () => {
  const rendered = new SkillRegistry().render(reviewSkill);
  assert.match(rendered, /# 技能：code-review/);
  assert.match(rendered, /边界条件/);
});

test('Agent 集成：命中技能时 system 事件注入日志', async () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const agent = new Agent(Runtime.createRuntime(config), registry);
  const result = await agent.runTask('请审查一下这段代码');
  const systems = result.events.filter((event) => event.type === 'system');
  assert.ok(systems.length >= 1, '应注入技能 system 事件');
  const content = (systems[0]?.payload as { content: string }).content;
  assert.match(content, /# 技能：code-review/);
});

test('Agent 集成：未命中技能不注入', async () => {
  const registry = new SkillRegistry();
  registry.register(reviewSkill);
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const agent = new Agent(Runtime.createRuntime(config), registry);
  const result = await agent.runTask('写一首诗');
  // 只统计技能专属 system 事件（render 标记 `# 技能：`），排除开场记忆 primer 等其它 system 事件。
  const skillEvents = result.events.filter(
    (event) =>
      event.type === 'system' &&
      /# 技能：/.test(String((event.payload as { content?: string } | undefined)?.content ?? '')),
  );
  assert.strictEqual(skillEvents.length, 0, '未命中技能不应注入技能 system 事件');
});
