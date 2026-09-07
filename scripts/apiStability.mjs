#!/usr/bin/env node
// 零依赖 API 稳定性契约校验器（OmniHarness 工程化门禁之一）
//
// 策略：公开桶 src/index.ts 的每一段「分区注释」必须声明该区稳定性
// （// @public / // @beta / // @deprecated），其下所有 export 继承该稳定性。
// 单条 export 也可用同行 /** @x */ 覆盖分区标注。
// 任何 export 若不在带标注的分区内，记为违规并阻断（exit 1）。
//
// 配套文档：docs/API_STABILITY.md
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGETS = [
  resolve(__dirname, '..', 'src', 'index.ts'),
  resolve(__dirname, '..', 'src', 'indexBeta.ts'),
];

/**
 * 校验公开桶源文本的稳定性标注完整性。
 * @param {string} source src/index.ts 的源码文本
 * @returns {{ violations: string[], tagged: number }}
 */
export function checkApiStability(source) {
  const lines = source.split(/\r?\n/);
  let current = null; // 当前分区稳定性
  const violations = [];
  let tagged = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 分区标签（独立 // 行）：// @public / // @beta / // @deprecated
    const sec = line.match(/^\s*\/\/\s*@(public|beta|deprecated)\b/);
    if (sec) {
      current = sec[1];
      continue;
    }
    // 行内标签（同行 /** @x */ export ...）覆盖分区
    const inline = line.match(/\/\*\*\s*@(public|beta|deprecated)\s*\*\//);
    const eff = inline ? inline[1] : current;
    // export 语句（非注释行）
    if (/^\s*export\b/.test(line)) {
      if (!eff) {
        violations.push(`L${i + 1}: 缺稳定性标注: ${line.trim().slice(0, 50)}`);
      } else {
        tagged++;
      }
    }
  }
  return { violations, tagged };
}

// CLI 入口
const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = args.length ? args.map((a) => resolve(a)) : DEFAULT_TARGETS;
  let totalViolations = 0;
  for (const target of targets) {
    const source = readFileSync(target, 'utf8');
    const { violations, tagged } = checkApiStability(source);
    if (violations.length === 0) {
      console.log(`✅ ${target}: ${tagged} 条 export 已落在带标注的分区内。`);
    } else {
      totalViolations += violations.length;
      console.error(`❌ ${target}: ${violations.length} 条 export 缺稳定性标注：`);
      for (const v of violations) console.error(`  - ${v}`);
    }
  }
  if (totalViolations > 0) {
    console.error(
      '（公开桶每项 export 必须落在 // @public / // @beta / // @deprecated 分区内，或用同行 /** @x */ 标注）',
    );
    process.exit(1);
  }
  process.exit(0);
}
