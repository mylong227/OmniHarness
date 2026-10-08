/**
 * Laya 路径解析单测（权威缝：**零配置可用**的判据）。
 *
 * ## 它锁的是什么
 *
 * 2026-10 实测出的头号缺陷是「声明未接线」：`THIRD_PARTY_ASSETS.md` 宣称适配器默认
 * `LAYA_PYTHON_BIN` 指向项目内 venv，而代码默认值恒为系统 `python3`（本机无 laya/torch）
 * ⇒ 1.7GB 的 venv + 权重零调用且无告警。故这里把解析顺序逐条钉死：
 * 显式参数 → 环境变量 → 项目内（**存在才用**）→ 兜底。任何一环被改回硬编码 `python3`，本文件即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LayaPaths } from '../../src/adapters/laya/layaPaths.js';

/** 解释器环境变量名（与实现同源；测的是行为不是字面量）。 */
const PYTHON_ENV = 'LAYA_PYTHON_BIN';
/** 权重目录环境变量名。 */
const MODEL_ENV = 'LAYA_MODEL_DIR';
/**
 * 平台兜底名（与实现同源口径）：Windows 猜 `python`（官方安装器 / conda 都是 `python.exe`），
 * 其它平台猜 `python3`。2026-10-07 评审指出写死 `python3` 会让 Windows 最常见组合在兜底档失败。
 */
const FALLBACK_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/**
 * 造一个「项目根」：含 `package.json` 标记，并按需创建 venv / 权重目录。
 * @param withVenv 是否创建 venv 解释器（平台对应布局）。
 * @param withModel 是否创建权重目录。
 * @returns 临时项目根路径。
 */
function makeProject(withVenv: boolean, withModel: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'laya-paths-'));
  writeFileSync(join(root, 'package.json'), '{}', 'utf8');
  if (withVenv) {
    const python = LayaPaths.venvPython(root);
    mkdirSync(join(python, '..'), { recursive: true });
    writeFileSync(python, '', 'utf8');
  }
  if (withModel) {
    mkdirSync(LayaPaths.projectModelDir(root), { recursive: true });
  }
  return root;
}

/**
 * 在临时环境变量下执行一段断言，结束后恢复原值。
 * @param key 环境变量名。
 * @param value 临时值（undefined 表示删除）。
 * @param run 待执行断言。
 * @returns 无返回值。
 */
function withEnv(key: string, value: string | undefined, run: () => void): void {
  const saved = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

test('pythonPath：显式参数优先于环境变量与项目内 venv', () => {
  const root = makeProject(true, true);
  try {
    withEnv(PYTHON_ENV, 'env-python', () => {
      assert.strictEqual(LayaPaths.pythonPath(root, 'explicit-python'), 'explicit-python');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pythonPath：环境变量优先于项目内 venv', () => {
  const root = makeProject(true, true);
  try {
    withEnv(PYTHON_ENV, 'env-python', () => {
      assert.strictEqual(LayaPaths.pythonPath(root), 'env-python');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pythonPath：无显式/环境变量时命中项目内 venv（存在的才用）', () => {
  const root = makeProject(true, true);
  try {
    withEnv(PYTHON_ENV, undefined, () => {
      assert.strictEqual(LayaPaths.pythonPath(root), LayaPaths.venvPython(root));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pythonPath：项目内 venv 缺失时回落平台兜底名（不指向不存在的路径）', () => {
  const root = makeProject(false, false);
  try {
    withEnv(PYTHON_ENV, undefined, () => {
      assert.strictEqual(LayaPaths.pythonPath(root), FALLBACK_PYTHON);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pythonPath：无项目标记（非仓库目录）时回落平台兜底名', () => {
  const root = mkdtempSync(join(tmpdir(), 'laya-paths-bare-'));
  try {
    withEnv(PYTHON_ENV, undefined, () => {
      assert.strictEqual(LayaPaths.pythonPath(root), FALLBACK_PYTHON);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('modelDir：显式 > 环境变量 > 项目内 > 空串', () => {
  const root = makeProject(false, true);
  try {
    assert.strictEqual(LayaPaths.modelDir(root, 'explicit-model'), 'explicit-model');
    withEnv(MODEL_ENV, 'env-model', () => {
      assert.strictEqual(LayaPaths.modelDir(root), 'env-model');
    });
    withEnv(MODEL_ENV, undefined, () => {
      assert.strictEqual(LayaPaths.modelDir(root), LayaPaths.projectModelDir(root));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('modelDir：项目内权重缺失时返回空串（转走在线 Router，不硬指缺失路径）', () => {
  const root = makeProject(false, false);
  try {
    withEnv(MODEL_ENV, undefined, () => {
      assert.strictEqual(LayaPaths.modelDir(root), '');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projectRoot：向上找到最近含 package.json 的祖先', () => {
  const root = makeProject(false, false);
  try {
    const nested = join(root, 'dist', 'src', 'adapters', 'laya');
    mkdirSync(nested, { recursive: true });
    assert.strictEqual(LayaPaths.projectRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
