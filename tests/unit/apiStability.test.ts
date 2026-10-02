import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileAsync } from '../helpers/childProcess.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

const repoRoot = resolve(process.cwd());
const checker = join(repoRoot, 'scripts', 'apiStability.mjs');
const stableBucket = join(repoRoot, 'src', 'index.ts');
const betaBucket = join(repoRoot, 'src', 'indexBeta.ts');

// 校验器是独立 .mjs 脚本，以子进程方式端到端验证（与其在 CI gate 中的运行方式一致）。
async function runChecker(target: string): Promise<{ ok: boolean; out: string }> {
  try {
    const out = await execFileAsync(process.execPath, [checker, target], { encoding: 'utf8' });
    return { ok: true, out: out.toString() };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      out: `${(err.stdout ?? '').toString()}${(err.stderr ?? '').toString()}`,
    };
  }
}

test('api:check 对本仓库稳定桶零违规', async () => {
  const { ok, out } = await runChecker(stableBucket);
  assert.ok(ok, `期望零违规，实际输出：\n${out}`);
  assert.match(out, /✅|已落在带标注/);
});

test('api:check 对本仓库实验桶（index.beta.ts）零违规', async () => {
  const { ok, out } = await runChecker(betaBucket);
  assert.ok(ok, `期望零违规，实际输出：\n${out}`);
  assert.match(out, /✅|已落在带标注/);
});

test('api:check 对缺稳定性标注的桶报非零退出', async () => {
  const tmp = join(tmpdir(), `omni_api_probe_${process.pid}.ts`);
  writeFileSync(tmp, 'export const x = 1;\n', 'utf8');
  try {
    const { ok, out } = await runChecker(tmp);
    assert.ok(!ok, `无标注的桶应失败，实际通过：\n${out}`);
    assert.match(out, /缺稳定性标注|失败/);
  } finally {
    rmSync(tmp, { force: true });
  }
});

test('api:check 对带 @beta 分区的桶零违规', async () => {
  const tmp = join(tmpdir(), `omni_api_probe2_${process.pid}.ts`);
  writeFileSync(tmp, '// @beta 实验\nexport const y = 2;\n', 'utf8');
  try {
    const { ok, out } = await runChecker(tmp);
    assert.ok(ok, `带 @beta 分区应零违规，实际：\n${out}`);
  } finally {
    rmSync(tmp, { force: true });
  }
});

test('api:check 对带 @deprecated 分区的桶零违规', async () => {
  const tmp = join(tmpdir(), `omni_api_probe3_${process.pid}.ts`);
  writeFileSync(tmp, '// @deprecated 旧实现（已被 X 取代）\nexport const z = 3;\n', 'utf8');
  try {
    const { ok, out } = await runChecker(tmp);
    assert.ok(ok, `带 @deprecated 分区应零违规，实际：\n${out}`);
  } finally {
    rmSync(tmp, { force: true });
  }
});
