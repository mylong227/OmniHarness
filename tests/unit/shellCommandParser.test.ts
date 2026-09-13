import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ShellCommandParser } from '../../src/adapters/tool/shell/shellCommandParser.js';

const parser = new ShellCommandParser();

describe('shellCommandParser 结构化解析', () => {
  it('单段命令：程序名与段数正确', () => {
    const outcome = parser.parse('ls -la');
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.deepStrictEqual(outcome.plan.segments, ['ls -la']);
    assert.deepStrictEqual(outcome.plan.programs, ['ls']);
    assert.strictEqual(outcome.plan.hasSubstitution, false);
    assert.strictEqual(outcome.plan.hasRedirection, false);
    assert.strictEqual(outcome.plan.hasChaining, false);
  });

  it('管道按顶层切段（管道不属于「串联」）', () => {
    const outcome = parser.parse('cat a.txt | grep beta | wc -l');
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.strictEqual(outcome.plan.segments.length, 3);
    assert.deepStrictEqual(outcome.plan.programs, ['cat', 'grep', 'wc']);
    assert.strictEqual(outcome.plan.hasChaining, false);
  });

  it('串联与重定向被分别标记', () => {
    const chained = parser.parse('npm run build && npm test');
    assert.strictEqual(chained.ok, true);
    if (chained.ok) {
      assert.strictEqual(chained.plan.hasChaining, true);
      assert.deepStrictEqual(chained.plan.programs, ['npm', 'npm']);
    }
    const redirected = parser.parse('ls > out.txt');
    assert.strictEqual(redirected.ok, true);
    if (redirected.ok) {
      assert.strictEqual(redirected.plan.hasRedirection, true);
    }
  });

  it('命令替换（$() 与反引号）被标记，含双引号内', () => {
    for (const command of ['echo $(date)', 'echo `date`', 'echo "$(date)"', 'echo "`date`"']) {
      const outcome = parser.parse(command);
      assert.strictEqual(outcome.ok, true, command);
      if (outcome.ok) {
        assert.strictEqual(outcome.plan.hasSubstitution, true, command);
      }
    }
  });

  it('单引号内的反引号不是命令替换（不误报）', () => {
    const outcome = parser.parse("echo '`date`'");
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.plan.hasSubstitution, false);
    }
  });

  it('剥离前置环境变量赋值取程序名', () => {
    const outcome = parser.parse('FOO=1 BAR=2 ls -la');
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.deepStrictEqual(outcome.plan.programs, ['ls']);
    }
  });

  it('带引号的程序路径不被空格切断', () => {
    const outcome = parser.parse('"/path/my prog" arg1');
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.deepStrictEqual(outcome.plan.programs, ['/path/my prog']);
    }
  });

  it('换行等价于分隔符', () => {
    const outcome = parser.parse('ls\nwc -l');
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.plan.segments.length, 2);
    }
  });

  it('fail-closed：引号未闭合 / 以分隔符结尾 / 空段 / NUL 一律拒绝', () => {
    const cases: readonly string[] = [
      'echo "unclosed',
      "echo 'unclosed",
      'ls |',
      'ls ; ; wc',
      'a\u0000b',
    ];
    for (const command of cases) {
      const outcome = parser.parse(command);
      assert.strictEqual(outcome.ok, false, `应拒绝：${command}`);
      if (!outcome.ok) {
        assert.ok(outcome.reason.length > 0);
      }
    }
  });

  it('fail-closed：纯空白命令被判定为空', () => {
    const outcome = parser.parse('   ');
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.reason, /命令为空/);
    }
  });
});
