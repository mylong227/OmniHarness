/**
 * F9「配置键出口」判据（2026-10-11）。
 *
 * ## 它锁的是什么
 *
 * 审计记的 F9：bundle 补丁层的告警只说"忽略非法配置项: x"，用户**拿不到任何出口**——
 * 不知道是键拼错了、类型不对、还是枚举越界，也不知道有哪些合法键。修法有三条腿，本文件逐条钉：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | `knownConfigKeys()` 非空、升序，且**仓库那份示例配置的每个顶层键都在其中** | 示例配置自己带着非法键 ⇒ 照抄示例必踩坑（且此前无人核对过这件事） |
 * | ② | 未知键报错必须**点名非法键 + 列出合法键 + 给总数出口** | 报错只说"不被支持"，用户只能翻源码 |
 * | ③ | bundle 补丁告警必须说出**原因**（未知键/枚举/类型三类可分辨），未知键那条还要带合法键清单 | `catch {}` 吞掉原因 ⇒ 只剩"忽略非法配置项: x" |
 *
 * 每条都配**正对照**：检测器/断言在"已知坏输入"下必须报违规，否则"'零违规'只是检测器失灵"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config/configError.ts';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 示例配置里的顶层键（去掉注释行后解析；解析失败则退回正则取样并如实报案）。 */
function exampleConfigKeys(): readonly string[] {
  const text = readFileSync(join(REPO_ROOT, 'omniharness.json.example'), 'utf8').replace(
    /^\uFEFF/u,
    '',
  );
  try {
    return Object.keys(JSON.parse(text) as Record<string, unknown>);
  } catch {
    return [...text.matchAll(/^\s*"([a-zA-Z][\w]*)"\s*:/gmu)].map((m) => m[1] ?? '');
  }
}

/**
 * 「示例配置里的键是否都在合法表里」检查器（抽成函数是为了给它做正对照）。
 *
 * @param keys 待检查的键。
 * @param legal 合法键表。
 * @returns 不在合法表里的键（空数组 = 全合法）。
 */
function illegalExampleKeys(keys: readonly string[], legal: readonly string[]): string[] {
  return keys.filter((key) => !legal.includes(key));
}

/** 捕获一次同步调用期间的 stderr 文本（本仓既有惯例：临时替换 write，同步块内完成）。 */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('① knownConfigKeys() 是唯一出口，且示例配置逐键合法（新增契约）', () => {
  const legal = ConfigError.knownConfigKeys();
  assert.ok(legal.length >= 10, `合法键表过小（${String(legal.length)} 项）⇒ 出口没有意义`);
  assert.deepStrictEqual(
    legal,
    [...legal].sort(),
    '合法键表必须升序（文案里按序展示，顺序漂了会误导）',
  );
  assert.ok(legal.includes('modelAdapter'), '基本键缺失 ⇒ 清单来源可疑');

  const example = exampleConfigKeys();
  assert.ok(example.length >= 8, `示例配置解析出的键过少（${String(example.length)}）⇒ 判据空转`);
  assert.deepStrictEqual(
    illegalExampleKeys(example, legal),
    [],
    'omniharness.json.example 里有**不被支持**的键 ⇒ 用户照抄示例必然踩"未知配置项"',
  );

  // **正对照**：同一检查器在已知坏输入下必须报违规（否则上面的"全合法"可能是恒真）。
  assert.deepStrictEqual(
    illegalExampleKeys([...example, '__no_such_key__'], legal),
    ['__no_such_key__'],
    '检查器认不出非法键 ⇒ 判据①恒真',
  );
});

test('② 未知键报错必须点名非法键 + 列出合法键 + 给总数出口', () => {
  let message = '';
  try {
    ConfigError.normalizeConfig({ 'no-such-key': 1 });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /未知配置项 "no-such-key"/u, '必须点名非法键');
  const legal = ConfigError.knownConfigKeys();
  const listed = legal.slice(0, 12).filter((key) => message.includes(key));
  assert.ok(
    listed.length >= 10,
    `报错里应列出合法键（至少 10 项），实际只列出 ${String(listed.length)} 项：${message}`,
  );
  assert.ok(
    message.includes(`共 ${String(legal.length)} 项`),
    `报错应给出合法键总数（共 ${String(legal.length)} 项）：${message}`,
  );
  assert.match(
    message,
    /omniharness\.json\.example/u,
    '报错应指向一个**真能跑**的出口（仓库内那份逐键合法的示例配置）',
  );
  // **正对照**：旧文案（只有"不被支持"一句）必须被判为"不合格"，否则本判据等于什么都没要求。
  const legacy = '配置错误: 未知配置项 "no-such-key"（标准名 "no-such-key" 不被支持）';
  assert.ok(
    !legacy.includes(`共 ${String(legal.length)} 项`) && !/可用：/u.test(legacy),
    '正对照写错了：旧文案本就不含合法键出口',
  );
});

test('③ bundle 补丁告警必须说出原因；三类非法可分辨，合法项照常生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-patch-keys-'));
  try {
    const patchDir = join(dir, '.omniharness', 'bundle-patches');
    mkdirSync(patchDir, { recursive: true });
    writeFileSync(
      join(patchDir, 'probe.json'),
      JSON.stringify({
        patches: [
          { key: 'maxSteps', value: 7 }, // 合法：必须生效
          { key: 'no-such-key', value: 1 }, // 未知键
          { key: 'modelAdapter', value: 'nope' }, // 枚举越界
          { key: 'maxSteps', value: 'abc' }, // 类型错
        ],
      }),
      'utf8',
    );
    const stderr = captureStderr(() => {
      const applied = ConfigError.loadBundlePatchLayer(dir);
      // 合法项照常生效：类型错的那条被跳过，故 `maxSteps` 仍是前面那条合法值 7。
      assert.strictEqual(applied.maxSteps, 7, '合法补丁必须生效（否则下面的告警判据是在空跑）');
      assert.strictEqual(
        (applied as Record<string, unknown>)['no-such-key'],
        undefined,
        '非法键不得被应用',
      );
    });

    // ① 每条告警都要带"原因：…"——这正是修复前 `catch {}` 吞掉的那部分。
    assert.match(
      stderr,
      /忽略非法配置项: no-such-key（来自 probe\.json）；原因：/u,
      '未知键告警缺原因',
    );
    assert.match(
      stderr,
      /忽略非法配置项: modelAdapter（来自 probe\.json）；原因：/u,
      '枚举报警缺原因',
    );
    assert.match(stderr, /取值 "nope" 非法，允许: /u, '枚举报警必须给出允许值（可行动）');
    assert.match(stderr, /no-such-key/u, '未知键告警必须点名该键');
    assert.match(stderr, /可用：/u, '未知键告警必须带合法键清单');

    // ② **正对照**：修复前的裸告警形态必须被判为"不合格"（否则本判据可以靠"打印了点东西"蒙过）。
    const legacy = '[omniharness] bundle 补丁层忽略非法配置项: no-such-key（来自 probe.json）\n';
    assert.ok(
      !/；原因：/u.test(legacy) && !/可用：/u.test(legacy),
      '正对照写错了：旧告警本就不含原因与合法键清单',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
