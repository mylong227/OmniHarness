import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';
import { GoalChecker, parseAchieved } from '../../src/autonomy/goalChecker.js';

/** 返回固定文本的模型桩。 */
class ScriptModel implements ModelPort {
  public readonly name = 'script';

  public constructor(private readonly text: string) {}

  public async generate(_request: ModelRequest): Promise<ModelOutput> {
    return { text: this.text };
  }
}

describe('parseAchieved', () => {
  it('显式 YES 视为达成', () => {
    assert.strictEqual(parseAchieved('YES'), true);
    assert.strictEqual(parseAchieved('YES 已完成'), true);
  });

  it('显式 NO 视为未达成', () => {
    assert.strictEqual(parseAchieved('NO'), false);
    assert.strictEqual(parseAchieved('NO 还没做完'), false);
  });

  it('含 YES 且无 NO 视为达成（宽松）', () => {
    assert.strictEqual(parseAchieved('目标 yes 了'), true);
  });

  it('含 YES 但也被 NO 修饰时保守判未达成', () => {
    assert.strictEqual(parseAchieved('not yes'), false);
    assert.strictEqual(parseAchieved('yes? no, 还差一步'), false);
  });

  it('无 YES/NO 关键词时保守判未达成（避免过早停止）', () => {
    assert.strictEqual(parseAchieved('目标仍在推进中'), false);
    assert.strictEqual(parseAchieved('The goal is now complete'), false);
  });
});

describe('GoalChecker', () => {
  it('模型判 YES 即达成', async () => {
    const checker = new GoalChecker(new ScriptModel('YES 已完成'));
    const result = await checker.check('写个函数', '函数已写好');
    assert.strictEqual(result.achieved, true);
    assert.match(result.raw, /YES/);
  });

  it('模型判 NO 即未达成', async () => {
    const checker = new GoalChecker(new ScriptModel('NO 还差测试'));
    const result = await checker.check('写个函数', '写了函数');
    assert.strictEqual(result.achieved, false);
  });
});
