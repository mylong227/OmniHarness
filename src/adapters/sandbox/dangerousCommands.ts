/**
 * 默认危险命令规则集合（Windows 与 Unix 常见破坏性命令）。
 *
 * 跨行约定：规则里的连接段一律用 `[\s\S]*?` 而**不是** `[^\n]*`。原因（2026-10-01 审计）：
 * 多行 shell 脚本天然含换行，`rm\n-rf /` 这类写法会把 `[^\n]*` 截断在第一行而绕过匹配。
 * 采用惰性 `[\s\S]*?` 后，标志位与动作词跨行仍可关联命中。
 */
export class DangerousCommands {
  /** 默认危险模式列表。
   * @returns 覆盖 Windows/Unix 常见破坏性命令的正则数组。
   */
  public defaults(): readonly RegExp[] {
    return [
      // ── 递归 / 强制删除 ──────────────────────────────────────────────
      /\brm\b[\s\S]*?-[rR][fF]\b/i,
      /\brm\b[\s\S]*?-[fF][rR]\b/i,
      /\brm\b[\s\S]*?-\s*r[\s\S]*?-\s*f\b/i,
      /\brm\b[\s\S]*?--recursive[\s\S]*?--force\b/i,
      /\brm\b[\s\S]*?--force[\s\S]*?--recursive\b/i,
      /\b(?:rmdir|rd)\b[\s\S]*?\/(?:s|q)\b/i,
      /\b(?:del|erase)\b[\s\S]*?\/(?:s|f|q)\b/i,
      // PowerShell 等价物（`Remove-Item -Recurse -Force` 即 `rm -rf`）：原先只封了 cmd 的 `del /s`。
      /\b(?:remove-item|ri)\b[\s\S]*?-(?:r|recurse)\b/i,
      // ── 磁盘 / 系统级破坏 ────────────────────────────────────────────
      /\bformat\b[\s\S]*?[a-z]:/i,
      /\b(?:mkfs|diskpart|fdisk)\b/i,
      /\bshutdown\b/i,
      /\breg\b[\s\S]*?\bdelete\b/i,
      /\bdd\b[\s\S]*?\bif=/i,
      // ── 下载后直接管道执行（前导不限于 curl/wget） ────────────────────
      /\b(?:curl|wget)\b[\s\S]*?\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd)/i,
      // `cat x | sh` / `base64 -d | bash` 之类：管道右侧落 shell 即视为执行，与前导命令无关。
      /\|\s*(?:sh|bash|zsh|fish|powershell|pwsh)\b(?:\s|$)/i,
      // ── 解释器内联执行（任意代码执行的正门，原先完全无规则） ──────────
      // 只拦「内联代码」形态（`-c` / `-e` / `-r` / `-Command`）；执行脚本文件（`python a.py`、
      // `node a.mjs`、`powershell -File a.ps1`）不受影响，仍走正常的路径与审批链。
      /\bpython[0-9.]*\b[\s\S]*?\s-(?:c|m\s+base64)\b/i,
      /\bnode\b[\s\S]*?\s-(?:e|eval)\b/i,
      /\b(?:perl|ruby|lua)\b[\s\S]*?\s-e\b/i,
      /\bphp\b[\s\S]*?\s-r\b/i,
      /\b(?:powershell|pwsh)\b[\s\S]*?-(?:c|command)\b/i,
      /\b(?:iex|invoke-expression)\b/i,
      // PowerShell 编码命令：载荷经 base64 隐藏，关键词匹配无从下手，只能按标志位拦。
      /-(?:enc|encodedcommand)\b/i,
      // ── 编码管道执行 ─────────────────────────────────────────────────
      /\bbase64\b[\s\S]*?(?:-d|--decode)[\s\S]*?\|\s*(?:sh|bash|python[0-9.]*|node|perl)\b/i,
      // ── 间接递归删除（用户点名的 git / find / xargs 通道，原先零覆盖） ──
      /\bgit\b[\s\S]*?\bclean\b[\s\S]*?-[a-z]*[fdx]/i,
      /\bfind\b[\s\S]*?-(?:delete|exec)\b/i,
      /\bxargs\b[\s\S]*?\brm\b/i,
    ];
  }
}

/** 默认实例（无状态、可并发复用，调用点以 `dangerousCommands.xxx` 零构造复用）。 */
export const dangerousCommands = new DangerousCommands();
