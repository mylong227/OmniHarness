/** 默认危险命令规则集合（Windows 与 Unix 常见破坏性命令）。 */
export class DangerousCommands {
  /** 默认危险模式列表。 */
  static defaults(): readonly RegExp[] {
    return [
      /\brm\b[^\n]*-rf\b/i,
      /\brm\b[^\n]*-fr\b/i,
      /\brm\b[^\n]*-r\s+f\b/i,
      /\b(?:rmdir|rd)\b[^\n]*\/s\b/i,
      /\b(?:del|erase)\b[^\n]*\/s\b/i,
      /\bformat\b[^\n]*[a-z]:/i,
      /\b(?:mkfs|diskpart|fdisk)\b/i,
      /\bshutdown\b/i,
      /\breg\b[^\n]*\bdelete\b/i,
      /\bdd\b[^\n]*\bif=/i,
      /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|powershell|cmd)/i,
    ];
  }
}
