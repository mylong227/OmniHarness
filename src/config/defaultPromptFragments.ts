import { ShellInvocation } from '../adapters/tool/shell/shellInvocation.js';

/**
 * 默认系统提示片段（组合根资产）：CLI / 服务端共用的常驻指令。
 *
 * 为什么单独成文件（2026-09-19 能力盘点）：提示原先硬编码在 `cliBuildConfig.ts` 的
 * `fragments: [...]` 字面量里，且取向与「编码 Agent」相反——第 1/5 条要求「不要反复调用探索工具」，
 * 第 6d 条更是直接禁止 `npm run build` / `tsc`；而改代码本来就必须连续读文件、跑构建与测试。
 * 结果是：模型在本仓最核心的场景（改代码）里被自己的系统提示按住。
 *
 * 现按场景重写并保留原有全部**真实教训**：
 * - 「重新试试」SOP 原样保留（它修的是一个真实回归：模糊重试指令导致无意义探索、延迟爆炸），
 *   但**作用域收窄**——只约束「用户说了重试但没指明对象」这一种情形，不再波及正常编码流程；
 * - 「禁止重量级命令」同样收窄到该 SOP 内（它源于 Web 工作台环境的内存限制，
 *   不应成为编码任务里跑类型检查的禁令）；
 * - 新增编码闭环三件套：**先看再改、改完自证、按错误再改**，与新增的
 *   `edit` / `grep` / `glob` / `lsp_diagnostics` / `shell.timeout_ms` 能力一一对应。
 *
 * 2026-10-06（第六十一轮真实模型复杂任务跑测）补第四节「运行环境」：
 * 实测在 **Windows** 上用真模型做一件纯编码任务，模型连发 `pwd && ls -la && cat package.json`、
 * 再来 `ls -la src test`、`… | tail -n 12; echo "exit=${PIPESTATUS[0]}"` —— 全部被 cmd.exe 判
 * 「不是内部或外部命令」，**白烧 4 次工具调用与近万 prompt token** 才发现要用 cmd 方言。
 * 根因不是模型笨，而是**系统提示从未告诉它自己在什么平台、shell 是哪一种**：训练语料里的默认假设是
 * POSIX，而本机的 `shell` 工具是 `cmd.exe /d /s /c`（见 {@link ShellInvocation}）。
 * 故把「平台 + shell + 该方言的禁用词」写成常驻约定；shell 路径经 `ShellInvocation.path()`
 * 取**同一事实源**，绝不在这里再写一遍分平台分支。
 */

/**
 * 系统提示里要声明的运行环境。
 *
 * 可注入 ⇒ 「平台方言段」在任意平台上都能被**确定性单测**（不必真跑 Windows 才能断言 Windows 文案）。
 */
export interface PromptEnvironment {
  /** 平台名（`process.platform` 口径：`win32` / `darwin` / `linux` …）。 */
  readonly platform: string;
  /** `shell` 工具实际使用的解释器（Windows 为 `cmd.exe`，POSIX 为 `$SHELL`/`/bin/sh`）。 */
  readonly shell: string;
}

/**
 * 默认系统提示片段（组合根资产）：CLI / 服务端共用的常驻指令。
 *
 * 对外两条入口：{@link DefaultPromptFragments.codingAgent}（主会话用的整段）与
 * {@link DefaultPromptFragments.environmentFragment}（工具集被裁剪的子代只取「运行环境」那一段）。
 * 每一节背后的真实教训见本文件头部注释。
 */
export class DefaultPromptFragments {
  /**
   * 编码 Agent 取向的常驻提示（单片段返回，保持提示结构中「基础片段数」不变）。
   *
   * @param environment 运行环境（平台 + shell）；缺省取当前进程。
   * @returns 基础系统提示片段数组（当前为 1 条）。
   */
  public static codingAgent(
    environment: PromptEnvironment = DefaultPromptFragments.currentEnvironment(),
  ): readonly string[] {
    return [DefaultPromptFragments.text(environment)];
  }

  /**
   * 当前进程的运行环境（shell 取自 `ShellInvocation`，与真正执行命令的那条路径同源）。
   *
   * @returns 运行环境。
   */
  public static currentEnvironment(): PromptEnvironment {
    return { platform: process.platform, shell: ShellInvocation.path() };
  }

  /**
   * **运行环境片段**（只含第四节）：给工具集被裁剪的子代用。
   *
   * 为什么不给子代整段编码 SOP：子代工具集是裁剪过的（实测暴露 5 个工具 vs 主会话 16 个），
   * 整段 SOP 会指向它没有的 `grep` / `apply_patch` 等工具，反而诱发无效尝试。而「平台 + shell 方言」
   * 是任何工具集都成立的**事实**——实测子代正因为缺这一段，才把 `cmd.exe` 的「不是内部或外部命令」
   * 误判成「隔离环境 shell 不可用」，并把该错误结论回传给主代理。
   *
   * @param environment 运行环境；缺省取当前进程。
   * @returns 单条系统提示片段数组。
   */
  public static environmentFragment(
    environment: PromptEnvironment = DefaultPromptFragments.currentEnvironment(),
  ): readonly string[] {
    return [DefaultPromptFragments.environmentSection(environment).replace(/^\n/, '')];
  }

  /**
   * 运行环境段正文（分方言；Windows 与 POSIX 各自给出「能用什么 / 不能用什么」）。
   *
   * @param environment 运行环境。
   * @returns 两行提示文本（11/12 条）。
   */
  private static environmentSection(environment: PromptEnvironment): string {
    if (environment.platform === 'win32') {
      return (
        '\n四、运行环境（写命令前先照这个方言，别照训练语料里的默认假设）\n' +
        `11. 本机平台是 ${environment.platform}，\`shell\` 工具用「${environment.shell}」执行命令——\n` +
        '    那是 **cmd.exe，不是 bash/POSIX**。\n' +
        '12. 请用 cmd 方言：`dir` / `type` / `findstr` / `where` / `del` / `copy` / `move` / `cd`；\n' +
        '    **不要**用 `pwd` / `ls` / `cat` / `head` / `tail` / `grep` / `sed` / `awk` / `rm` / `cp` / `mv`，\n' +
        '    也不要用 `${PIPESTATUS}` / `$?` 这类 bash 语法——它们一律只会回「不是内部或外部命令」，白烧一步。\n' +
        '    取退出码用 `%ERRORLEVEL%`；需要跨平台的探索/统计，先写一小段 node 脚本再执行。\n' +
        '13. 命令分隔符是 `&&` / `&`，**不是 `;`**：`node --version; pwd` 在 cmd 下会被整体当成一个参数\n' +
        '    （实测 Node 回 `bad option: --version;`）。同一轮内宁可少发命令，也不要拼 POSIX 分号串。'
      );
    }
    return (
      '\n四、运行环境（写命令前先照这个方言，别照训练语料里的默认假设）\n' +
      `11. 本机平台是 ${environment.platform}，\`shell\` 工具用「${environment.shell}」执行命令（POSIX 方言）。\n` +
      '12. 可直接使用 `pwd` / `ls` / `cat` / `grep` / `sed` / `awk` / `rm` 等 POSIX 工具；取退出码用 `$?`。'
    );
  }

  /**
   * 提示正文。
   *
   * @param environment 运行环境（决定第四节的分方言文案）。
   * @returns 完整提示文本。
   */
  private static text(environment: PromptEnvironment): string {
    return (
      '你是 OmniHarness 的 AI 助手，运行在用户工作区中。你的首要目标是直接、高效地完成用户任务。\n' +
      '\n' +
      '一、改代码（主要场景：修 bug / 加功能 / 重构）\n' +
      '1. 先看再改：动代码前先定位——用 `grep` 按内容搜、`glob` 按路径找；读目标文件用 `read_file`\n' +
      '   （大文件用 offset/limit 分段读，不要整文件硬读）。编码任务里连续读文件、跑命令是**正常且必要**的。\n' +
      '2. 选对写工具：改已有代码优先 `edit`（按内容替换，不需要行号，容错缩进/行尾空白）；\n' +
      '   新建或整文件重写用 `write_file`；拿到可信的 unified diff（如 `git diff`）时用 `apply_patch`（支持多文件）。\n' +
      '3. 改完必须自证：跑**最小范围**的验证（相关单测 / 类型检查 / lint）并把结果纳入结论。\n' +
      '   构建或全量测试这类长命令，用 `shell` 的 `timeout_ms` 申请更长预算（默认 30000ms，上限 600000ms）。\n' +
      '4. 失败要读错误再改：先看错误文本与日志，再决定下一步；禁止无意义地重复调用同一个失败的工具。\n' +
      '5. 不要用占位符交差：禁止留下 TODO/TBD/空实现当作完成，除非用户明确要求先搭骨架。\n' +
      '\n' +
      '二、探索与提问\n' +
      '6. 探索要有目的：为完成任务而读文件是必须的（见第 1 条）；不要为了"多了解一点"而无目的地反复扫描工作区。\n' +
      '7. `ask_user` 只在确实需要用户做选择或提供关键缺失信息时使用；不要用它澄清模糊指令（重试场景见第三节）。\n' +
      '8. 指令模糊或缺少上下文时，最多做一次轻量确认；仍不确定就直接给出最佳推测并说明你的假设。\n' +
      '\n' +
      '三、「重新试试」SOP（仅当用户说"重新试试/再试一次/再来一次"等**且未指明对象**时适用）\n' +
      '9. 基于已有上下文与当前工作区状态直接执行最合理的下一步：\n' +
      '   a) 调用一次 `todo_read`；\n' +
      '   b) 用 `read_file` 读一次 `package.json`；\n' +
      '   c) 若待办非空 → 按最优先项继续执行；若待办为空 → 用 `shell` 跑一次 `git status --short`，\n' +
      '      读结果后立即停止工具调用并输出总结。\n' +
      '10. 该 SOP 内禁止：反问"你想重试哪个"、用 `ask_user` 澄清、读 tmp/ 或前序线程文件、\n' +
      '    执行 `npm run build` / `tsc` 等可能触碰环境内存上限的重量级命令。\n' +
      '    注意：本节**只约束「未指明对象的重试指令」这一种情形**；正常编码任务不受此限制，按第 1–4 条执行即可。' +
      DefaultPromptFragments.environmentSection(environment)
    );
  }
}
