import { spawnSync } from 'node:child_process';
import type { RepoPathGuard } from './repoPathGuard.js';

/** DiffReview 构造选项。 */
export interface DiffReviewOptions {
  /** 当前工作区根 getter（兼容运行时切换工作区）。 */
  readonly workspaceRoot: () => string;
  /** 仓库内相对路径守卫（复用 fail-closed 路径策略）。 */
  readonly guard: RepoPathGuard;
}

/**
 * 内联 diff 审查领域服务（对标 Codex Review）：hunk / file 级 stage / revert，
 * 全部落到真实 `git` 操作，并在动手前做「是 git 仓库 + 路径在仓库内」双重 fail-closed 校验。
 *
 * 与 RPC 层解耦：入参为 RPC 原始参数对象，校验信息与返回结构保持与原实现逐字一致，
 * 便于被 Web / CLI / 测试等多入口复用。
 */
export class DiffReview {
  /**
   * @param options 工作区根 getter 与路径守卫。
   */
  public constructor(private readonly options: DiffReviewOptions) {}

  /**
   * 校验当前工作区为 git 仓库。
   * @returns 工作区根绝对路径。
   * @throws 工作区不是 git 仓库时（stage/revert 前置条件）。
   */
  public gitRootOrFail(): string {
    const ws = this.options.workspaceRoot();
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ws,
      encoding: 'utf8',
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      throw new Error('当前工作区不是 git 仓库，无法执行 stage/revert');
    }
    return ws;
  }

  /**
   * stage 整个文件（含未跟踪新文件）：`git add -- path`。
   * @param params RPC 参数，需 `path`（仓库内相对路径）。
   * @returns `{ ok: true }`。
   * @throws path 缺失/非法、工作区非 git 仓库或 `git add` 失败时。
   */
  public stageFile(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    if (typeof raw !== 'string') throw new Error('changes.stageFile 需要 path');
    const ws = this.gitRootOrFail();
    const rel = this.options.guard.resolve(raw);
    const add = spawnSync('git', ['add', '--', rel], { cwd: ws, encoding: 'utf8' });
    if (add.status !== 0) {
      throw new Error('git add 失败：' + (add.stderr || add.stdout).trim());
    }
    return { ok: true };
  }

  /**
   * 丢弃整个文件的工作区改动（还原到 index 版本）。
   * @param params RPC 参数，需 `path`。
   * @returns `{ ok: true }`。
   * @throws 未跟踪文件拒绝服务端删除（防误删）、工作区非 git 仓库或 `git checkout` 失败时。
   */
  public revertFile(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    if (typeof raw !== 'string') throw new Error('changes.revertFile 需要 path');
    const ws = this.gitRootOrFail();
    const rel = this.options.guard.resolve(raw);
    if (this.fileStatus(ws, rel) === '??') {
      throw new Error('未跟踪文件不做服务端丢弃（防误删），请手动删除或先 stage');
    }
    const co = spawnSync('git', ['checkout', '--', rel], { cwd: ws, encoding: 'utf8' });
    if (co.status !== 0) {
      throw new Error('git checkout 失败：' + (co.stderr || co.stdout).trim());
    }
    return { ok: true };
  }

  /**
   * stage 单个 hunk：`git apply --cached`。未跟踪新文件先 `git add -N` 建立意向项。
   * @param params RPC 参数，需 `path` 与 `hunk` 文本，可选 `isNew=true`。
   * @returns `{ ok: true }`。
   * @throws path/hunk 缺失或非法、工作区非 git 仓库、`git add -N` 或 `git apply --cached` 失败时。
   */
  public stageHunk(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const hunk = params['hunk'];
    if (typeof raw !== 'string') throw new Error('changes.stageHunk 需要 path');
    if (typeof hunk !== 'string' || hunk.trim() === '') {
      throw new Error('changes.stageHunk 需要 hunk 文本');
    }
    const ws = this.gitRootOrFail();
    const rel = this.options.guard.resolve(raw);
    if (params['isNew'] === true) {
      // 未跟踪文件先进 index 意向区（intent-to-add），否则 --cached apply 无目标。
      const addN = spawnSync('git', ['add', '-N', '--', rel], { cwd: ws, encoding: 'utf8' });
      if (addN.status !== 0) {
        throw new Error('git add -N 失败：' + (addN.stderr || addN.stdout).trim());
      }
    }
    const apply = spawnSync('git', ['apply', '--cached', '--recount', '--whitespace=nofix', '-'], {
      cwd: ws,
      encoding: 'utf8',
      input: this.hunkPatchText(rel, hunk),
    });
    if (apply.status !== 0) {
      throw new Error('git apply --cached 失败：' + (apply.stderr || apply.stdout).trim());
    }
    return { ok: true };
  }

  /**
   * 丢弃单个 hunk 的工作区改动：`git apply -R`（反向应用于工作树）。
   * @param params RPC 参数，需 `path` 与 `hunk` 文本。
   * @returns `{ ok: true }`。
   * @throws path/hunk 缺失或非法、工作区非 git 仓库或 `git apply -R` 失败时。
   */
  public revertHunk(params: Record<string, unknown>): unknown {
    const raw = params['path'];
    const hunk = params['hunk'];
    if (typeof raw !== 'string') throw new Error('changes.revertHunk 需要 path');
    if (typeof hunk !== 'string' || hunk.trim() === '') {
      throw new Error('changes.revertHunk 需要 hunk 文本');
    }
    const ws = this.gitRootOrFail();
    const rel = this.options.guard.resolve(raw);
    const apply = spawnSync('git', ['apply', '-R', '--recount', '--whitespace=nofix', '-'], {
      cwd: ws,
      encoding: 'utf8',
      input: this.hunkPatchText(rel, hunk),
    });
    if (apply.status !== 0) {
      throw new Error('git apply -R 失败：' + (apply.stderr || apply.stdout).trim());
    }
    return { ok: true };
  }

  /**
   * 单 hunk 补丁文本：`--- a/…` / `+++ b/…` 文件头 + hunk（@@ 行与正文）。
   * @param rel 仓库内相对路径。
   * @param hunk hunk 文本（必须含 `@@` 头）。
   * @returns 可喂给 `git apply` 的补丁文本。
   * @throws hunk 缺少 `@@` 头时。
   */
  private hunkPatchText(rel: string, hunk: string): string {
    if (!hunk.includes('@@')) throw new Error('hunk 文本缺少 @@ 头');
    return `--- a/${rel}\n+++ b/${rel}\n${hunk.replace(/\n+$/, '')}\n`;
  }

  /**
   * 指定文件的两字符 porcelain 状态（?? / A / M / D / R…）。
   * @param ws 工作区根。
   * @param rel 仓库内相对路径。
   * @returns 两字符状态，仓库异常时返回空串。
   */
  private fileStatus(ws: string, rel: string): string {
    const st = spawnSync('git', ['status', '--porcelain', '--', rel], {
      cwd: ws,
      encoding: 'utf8',
    });
    return st.status === 0 ? st.stdout.slice(0, 2).trim() : '';
  }
}
