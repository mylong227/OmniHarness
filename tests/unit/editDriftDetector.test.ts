// T4.2（H2 反漂移检测）可证伪验收：
//   ① 循环编辑（振荡 A→B→A）可告警；
//   ② 高频重写（thrash）可告警；
//   ③ 健康编辑（单调前进 + 分散多文件）零误报；
//   ④ 确定性：同事件序列重复运行恒同告警。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EditDriftDetector } from '../../src/eval/editDriftDetector.js';

test('① 振荡告警：A→B→A 内容指纹回退被检出（默认灵敏度 1）', () => {
  const d = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 50 });
  const edit = (rev: string) => d.record({ file: 'src/foo.ts', revision: rev });
  assert.strictEqual(edit('v1'), undefined);
  assert.strictEqual(edit('v2'), undefined);
  const alarm = edit('v1'); // 回到 v1 → 振荡
  assert.ok(alarm, '指纹回退必须告警');
  assert.strictEqual(alarm!.kind, 'oscillation');
  assert.match(alarm!.detail, /v1→v2→v1/);
});

test('② 高频重写告警：窗口内同文件编辑超阈值', () => {
  const d = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 3 });
  let n = 0;
  const edit = () => d.record({ file: 'src/bar.ts', revision: `v${n++}` });
  edit();
  edit();
  edit();
  const alarm = edit(); // 第 4 次同文件编辑（阈值 3）
  assert.ok(alarm, '第 4 次同文件编辑应告警');
  assert.strictEqual(alarm!.kind, 'thrash');
  assert.match(alarm!.detail, /阈值 3/);
});

test('③ 零误报：单调前进 + 多文件分散的健康编辑不告警', () => {
  const d = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 5 });
  let v = 0;
  for (let i = 0; i < 30; i++) {
    const file = `src/file${i % 6}.ts`;
    const alarm = d.record({ file, revision: `v${v++}` }); // 每文件指纹单调前进
    assert.strictEqual(alarm, undefined, `健康编辑在第 ${i} 步不应告警`);
  }
});

test('③b 指纹不变（重复提交同一内容）不算编辑、不触发告警', () => {
  const d = new EditDriftDetector({ maxEditsPerFile: 2 });
  for (let i = 0; i < 6; i++) {
    const alarm = d.record({ file: 'src/same.ts', revision: 'v1' });
    assert.strictEqual(alarm, undefined, '内容未变的记录不构成编辑');
  }
});

test('④ 确定性：同事件序列重复运行 20 次恒同告警序列', () => {
  const run = () => {
    const d = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 3 });
    const seq: string[] = [];
    const events = [
      { file: 'a.ts', revision: 'v1' },
      { file: 'a.ts', revision: 'v2' },
      { file: 'a.ts', revision: 'v3' },
      { file: 'a.ts', revision: 'v2' }, // 振荡
      { file: 'a.ts', revision: 'v4' }, // 第 5 次 → thrash
    ];
    for (const e of events) {
      const alarm = d.record(e);
      seq.push(alarm ? alarm.kind : 'ok');
    }
    return seq;
  };
  const first = run();
  assert.deepStrictEqual(first, ['ok', 'ok', 'ok', 'oscillation', 'thrash']);
  for (let i = 0; i < 19; i++) assert.deepStrictEqual(run(), first, '同输入必须恒同告警');
});
