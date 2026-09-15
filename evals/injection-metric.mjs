/**
 * A4 离线注入度量 harness（零依赖、离线）。
 *
 * 读 `evals/fixtures/injection-snapshot.json`（离线 curated，不联网），
 * 调编译后的 `evaluateSnapshot` 跑 `promptInjectionGuard#scanForInjection`，
 * 写出 `evals/injection-metric.report.json` 并打印摘要。
 *
 * 用法（构建后）：`node evals/injection-metric.mjs`
 * 或 npm：        `npm run metrics:injection`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateSnapshot } from '../dist/src/security/injectionMetric.js';

const here = dirname(fileURLToPath(import.meta.url));
const snapPath = join(here, 'fixtures', 'injection-snapshot.json');
const reportPath = join(here, 'injection-metric.report.json');

const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
const cases = snapshot.cases;
const report = evaluateSnapshot(cases);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const lines = [];
lines.push('=== A4 离线注入度量（promptInjectionGuard#scanForInjection）===');
lines.push(`快照来源: ${snapshot.source}`);
lines.push(`用例: ${report.total}（恶意 ${report.malicious} / 良性 ${report.benign}）`);
lines.push(`检测率 recall = ${pct(report.recall)}  (TP=${report.tp}, FN=${report.fn})`);
lines.push(`误报率 FP    = ${pct(report.falsePositiveRate)}  (FP=${report.fp}, TN=${report.tn})`);
lines.push(`精度 precision = ${pct(report.precision)}`);
lines.push(`准确率 accuracy = ${pct(report.accuracy)}`);
lines.push('--- 按类别 ---');
for (const [cat, s] of Object.entries(report.byCategory)) {
  lines.push(
    `  ${cat}: total=${s.total} detected=${s.detected} fp=${s.fp} recall=${pct(s.recall)} fpRate=${pct(s.fpRate)}`,
  );
}
lines.push(`报告已写出: ${reportPath}`);
process.stdout.write(lines.join('\n') + '\n');

writeFileSync(reportPath, JSON.stringify({ snapshot: snapshot.source, ...report }, null, 2) + '\n');
