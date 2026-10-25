// @vitest-environment jsdom
// 技能目录 / 自动化任务面板：读取、创建调用、空态。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';
import { allText, byClass, byTag, facadeOf } from './domFacade.ts';
import { SkillsTab } from '../src/ui/components/tabs/SkillsTab.tsx';
import { AutomationsTab } from '../src/ui/components/tabs/AutomationsTab.tsx';

test('SkillsTab：列出技能并支持过滤', async () => {
  const ui = await renderFacadeAsync(SkillsTab, {
    responses: {
      listSkills: async () => ({
        skills: [
          { name: 'review', description: '代码审查', tags: ['git'] },
          { name: 'test', description: '运行测试', tags: [] },
        ],
      }),
    },
  });
  await waitFor(() => assert.match(allText(ui.node), /review/u));
  assert.match(allText(ui.node), /test/u);
  const tree = (): ReturnType<typeof facadeOf> => facadeOf(ui.container.firstElementChild);
  const search = byTag(tree(), 'input')[0];
  assert.ok(search !== undefined);
  fireEvent.change(search.el, { target: { value: 'git' } });
  await waitFor(() => assert.doesNotMatch(allText(tree()), /\/test/u));
});

test('AutomationsTab：创建任务调用 createAutomation', async () => {
  const calls: unknown[] = [];
  const ui = await renderFacadeAsync(AutomationsTab, {
    responses: {
      listAutomations: async () => [],
      createAutomation: async (input: unknown) => {
        calls.push(input);
        return { id: 'auto_1' };
      },
    },
  });
  await waitFor(() => assert.match(allText(ui.node), /还没有自动化任务/u));
  const inputs = byTag(ui.node, 'input');
  const name = inputs.find((n) => n.props['aria-label'] === '自动化名称');
  const minutes = inputs.find((n) => n.props['aria-label'] === '自动化间隔分钟');
  const prompt = byTag(ui.node, 'textarea')[0];
  assert.ok(name !== undefined && minutes !== undefined && prompt !== undefined);
  fireEvent.change(name.el, { target: { value: '日报' } });
  fireEvent.change(prompt.el, { target: { value: '总结今天' } });
  fireEvent.change(minutes.el, { target: { value: '30' } });
  const create = byTag(ui.node, 'button').find((b) => allText(b) === '创建');
  assert.ok(create !== undefined);
  fireEvent.click(create.el);
  await waitFor(() => assert.strictEqual(calls.length, 1));
  assert.deepStrictEqual(calls[0], { name: '日报', prompt: '总结今天', intervalMinutes: 30 });
});

test('AutomationsTab：空态不渲染任务行动作', async () => {
  const ui = await renderFacadeAsync(AutomationsTab, {
    responses: { listAutomations: async () => [] },
  });
  await waitFor(() => assert.match(allText(ui.node), /还没有自动化任务/u));
  assert.strictEqual(byClass(ui.node, 'auto-row').length, 0);
});
