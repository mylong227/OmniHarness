// 判据：antd 边界守卫（ADR-0018 决策 4）——第三方 UI 基座只允许出现在视图层。
//
// 口径：
//   · `antd` / `@ant-design/*` / `rc-*`（antd 内部件）/ `dayjs`（antd 日期内核）的 import，
//     只允许出现在 `web/src/ui/**` 与 `web/src/poc/**`（W0 PoC 隔离入口，W5 收口时移除该豁免）；
//   · `web/src/core/**`、`web/src/types/**` 与后端 `src/**` 恒为第三方-free（架构门禁既有口径，
//     这里把「新增的 UI 基座家族」补进同一道防线）；
//   · `web/test/**` 不在扫描面内（判据夹具可以渲染 antd 组件）。

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
/** 扫描面：后端 src/** 与前端 web/src/**。 */
const SCAN_ROOTS = [join(ROOT, 'src'), join(ROOT, 'web', 'src')];
/** 允许 import UI 基座的前缀（相对 ROOT，正斜杠）。 */
const ALLOWED_PREFIXES = ['web/src/ui/', 'web/src/poc/'];
/** 受控模块家族：UI 基座本体 + 它的命名空间 + 内部件 + 日期内核。 */
const MODULE_RE = /(?:from\s+|import\s*\(\s*)['"](antd|@ant-design\/[^'"]+|rc-[a-z0-9-]+|dayjs(?:\/[^'"]+)?)['"]/g;

/** 递归收集 .ts/.tsx 文件（相对 ROOT 的正斜杠路径）。 */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'dist-poc') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test('antd 家族只出现在 web/src/ui/**（与临时 PoC）里', () => {
  const offenders: string[] = [];
  for (const rootDir of SCAN_ROOTS) {
    for (const file of walk(rootDir)) {
      const rel = file.split('\\').join('/').slice(ROOT.length + 1);
      if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(MODULE_RE)) {
        offenders.push(`${rel}: import '${m[1]}'`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'UI 基座越界（只允许 web/src/ui/**；PoC 豁免到 W5 收口）：\n' + offenders.join('\n'),
  );
});
