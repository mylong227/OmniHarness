import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SparkController } from '../../src/spark/sparkController.js';
import { JsonlRuntimeTelemetry } from '../../src/adapters/telemetry/jsonlRuntimeTelemetry.js';
import { ConfinementEngine } from '../../src/adapters/monitoring/confinementEngine.js';

test('SparkController.cycle 经 telemetry 落盘一条 production 观测', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'spark-tel-')), 'live.log');
  const tel = new JsonlRuntimeTelemetry({ path });
  const confinement = new ConfinementEngine({});
  const sc = new SparkController({
    confinement,
    confinementProbe: () => ({
      id: 'probe-bare',
      charge: { color: 1, flavor: 0, permission: 0, expiry: 0 },
    }),
    telemetry: tel,
    autoRun: true,
  });
  const report = await sc.cycle();
  assert.strictEqual(report.ran, true);
  const prod = tel.read().filter((o) => o.provenance === 'production');
  // 逐引擎发射：仅启用 confinement → 一条 operator='confinement' 的 production 观测。
  assert.strictEqual(prod.length, 1);
  assert.strictEqual(prod[0]?.operator, 'confinement');
  assert.strictEqual(prod[0]?.metrics.exposed, 0);
  assert.strictEqual(prod[0]?.metrics.confined, 1);
  assert.strictEqual(tel.verify().ok, true);
});

test('未配置 telemetry → cycle 正常跑、不落盘（零破坏旁路）', async () => {
  const sc = new SparkController({
    confinement: new ConfinementEngine({}),
    confinementProbe: () => ({
      id: 'probe-bare',
      charge: { color: 1, flavor: 0, permission: 0, expiry: 0 },
    }),
    autoRun: true,
  });
  // 无 telemetry 端口：不抛错、正常返回报告（含 confinement 裁决）
  const report = await sc.cycle();
  assert.strictEqual(report.ran, true);
  assert.strictEqual(report.confinement?.exposed, false);
});
