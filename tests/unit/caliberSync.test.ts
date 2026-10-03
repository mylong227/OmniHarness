/**
 * **口径同步**判据（G22，2026-10-03 第二十轮）。
 *
 * ## 它锁的是什么
 *
 * 报告 G22 的诉求是"把口径写进 `CODE_STANDARD.md` 与看板 §9，**避免下一轮再错**"。但把口径写进文档
 * 只解决一半问题——**文档会与代码漂移**：`MAX_FILE_LINES` 从 800 改成 810 时，文档里的 800 不会自己更新，
 * 于是下一个人照文档理解，又错了同一件事。
 *
 * 故本判据的核心是**交叉核对**：文档里写的每个阈值，都必须与**真正强制它的门禁常量**一致。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `CODE_STANDARD.md` 有 §11 口径章节，且含「计数 / 评测 / 门禁」三个子节 |
 * | ② | 文档写的**单文件行数上限** == `scripts/check.mjs` 的 `MAX_FILE_LINES`（两侧一起改才绿） |
 * | ③ | 文档写的**上帝类判据** == `scripts/auditStandards.mjs` 的判定式（`codeLines > 500 \|\| methods > 25`） |
 * | ④ | 文档写明**行数口径**（逐文件求和）**并**指出 `Measure-Object -Line` 少计空行（否则下轮还会用错口径） |
 * | ⑤ | 文档写明**两关**评测口径与**缓存读不相加**，且这两条在代码里确有对应物 |
 * | ⑥ | 看板 §9 指向 §11（口径从 SSOT 可达，而不是埋在长文档里） |
 * | ⑦ | 文档不得残留已作废的旧阈值（如把行数上限写成 800）——防"改了一处漏一处" |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * 读仓库内文本文件。
 * @param rel 相对仓库根的路径。
 * @returns 文件内容。
 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const CODE_STANDARD = read('docs/CODE_STANDARD.md');
const BOARD = read('docs/PROJECT_BOARD.md');

test('① CODE_STANDARD 有 §11 口径章节，含计数 / 评测 / 门禁三个子节', () => {
  assert.match(CODE_STANDARD, /^## 11\. 口径/m, '缺 §11 口径章节');
  for (const section of ['计数口径', '评测口径', '门禁口径']) {
    assert.ok(CODE_STANDARD.includes(section), `§11 缺子节「${section}」`);
  }
});

test('② 文档写的单文件行数上限 == check.mjs 的 MAX_FILE_LINES（两侧一致才绿）', () => {
  const gate = read('scripts/check.mjs');
  const gateCap = Number((/const MAX_FILE_LINES = (\d+);/.exec(gate) ?? [])[1]);
  assert.ok(Number.isFinite(gateCap), 'check.mjs 里没找到 MAX_FILE_LINES');
  // 文档必须出现同一数字，且出现在口径章节的语境里。
  assert.ok(
    CODE_STANDARD.includes(String(gateCap)),
    `文档未写出门禁实际的行数上限 ${String(gateCap)}（改了门禁就必须同步改文档）`,
  );
  assert.match(
    CODE_STANDARD,
    new RegExp(`单文件不得超过 \\*\\*${String(gateCap)}\\*\\* 行`),
    `文档未以明确措辞写出上限 ${String(gateCap)} 行`,
  );
});

test('③ 文档写的上帝类判据 == auditStandards.mjs 的判定式', () => {
  const audit = read('scripts/auditStandards.mjs');
  const m =
    /const godClass = classes\.length > 0 && \(codeLines > (\d+) \|\| maxMethods > (\d+)\);/.exec(
      audit,
    );
  assert.ok(m !== null, 'auditStandards.mjs 的上帝类判定式形状变了（本判据需同步更新）');
  const [, codeLines, methods] = m;
  assert.ok(
    CODE_STANDARD.includes(`codeLines > ${String(codeLines)}`) &&
      CODE_STANDARD.includes(`> ${String(methods)}`),
    `文档未写出实际上帝类判据（codeLines > ${String(codeLines)} 或 methods > ${String(methods)}）`,
  );
});

test('④ 文档写明行数口径是"逐文件求和"，并指出 Measure-Object -Line 少计空行', () => {
  assert.match(CODE_STANDARD, /逐文件/, '文档未写明行数口径是逐文件求和');
  assert.match(CODE_STANDARD, /\(Get-Content \$f\)\.Count/, '文档未给出正确口径的具体写法');
  assert.match(CODE_STANDARD, /Measure-Object -Line/, '文档未点名错误口径');
  assert.match(CODE_STANDARD, /少计空行|少计 .*行/, '文档未说明错误口径为什么错（少计空行）');
});

test('⑤ 文档写明"两关"评测口径与"缓存读不相加"，且代码里确有对应物', () => {
  assert.match(CODE_STANDARD, /两关/, '文档未写明两关评测口径');
  assert.match(CODE_STANDARD, /不跨 0/, '文档未写明 CI 不跨 0 这一关');
  assert.match(CODE_STANDARD, /留出折/, '文档未写明留出折这一关');
  // 对应物 1：两关判定确实在探针里实现（不是纸面要求）。
  assert.match(
    read('tools/probes/rerankDiscriminatorAb.mjs'),
    /verdictOf/,
    '探针未实现两关判定 ⇒ 文档里的口径没有落地处',
  );
  // 对应物 2：缓存读口径在语义约定常量与一致性判据里。
  assert.match(CODE_STANDARD, /缓存读/, '文档未写明缓存读 token 口径');
  assert.match(
    read('src/observability/genAiSemconv.ts'),
    /input_tokens/,
    '语义约定常量里没有 input_tokens ⇒ 文档口径与实现脱节',
  );
});

test('⑥ 看板 §9 指向 CODE_STANDARD §11（口径从 SSOT 可达）', () => {
  assert.match(BOARD, /### 9\.1 口径/, '看板 §9 没有口径小节');
  assert.match(
    BOARD,
    /CODE_STANDARD\.md\) §11|CODE_STANDARD\.md §11/,
    '看板未指向 CODE_STANDARD §11（口径埋在长文档里等于没有）',
  );
});

test('⑦ 不残留已作废的旧阈值（改阈值时必须全局同步）', () => {
  const gateCap = Number(
    (/const MAX_FILE_LINES = (\d+);/.exec(read('scripts/check.mjs')) ?? [])[1],
  );
  if (gateCap !== 800) {
    assert.ok(
      !/上限 \*\*800\*\* 行|MAX_FILE_LINES = 800|单文件行数上限.{0,12}800/.test(CODE_STANDARD),
      '文档里仍写着旧的行数上限 800（应同步为门禁实际值）',
    );
  }
  assert.ok(
    !/Measure-Object -Line 是正确口径/.test(CODE_STANDARD),
    '文档反过来把错误口径写成正确的',
  );
});
