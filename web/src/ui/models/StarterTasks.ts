// 中栏空态的「快速开始」示例任务（纯数据 + 纯函数，零 React ⇒ 可在 node --test 下判据）。
//
// ## 为什么需要它（2026-10-08 易用性轮，真机截图取证）
//
// 新客户打开工作台看到的中栏是：
//
//   等待任务
//   下达任务后，模型推理、工具调用与结果将在此实时呈现。
//
// ——这句话只说了"这里会发生什么"，**没有说"我该输入什么"**。而 OmniHarness 的能力面很宽
// （读写文件 / 跑命令 / 搜索 / 调 MCP / 编排），第一次用的人最可能的结局是关掉页面。
// 学习成本的最大来源不是功能复杂，而是"第一句话不知道怎么写"。
//
// 本清单给出**四句话覆盖四条核心通路**，点一下即填进输入框（可改后再发，见
// `ComposerController.seedDraft` 的说明：填入而非直接发送，既不替用户做决定、也不凭空花额度）。
//
// ## 口径（改这份清单时必须一并满足）
//
//   ① 每条 prompt **必须能直接发送**——不留 `{文件名}` 这类占位符给用户猜；
//   ② 四条覆盖 read / shell / search / write 四条通路（判据断言关键词，防被改成四条同质示例）；
//   ③ 文案用**客户的语言**（"跑一下这条命令看看输出"），不写工具名（`read_file`）——
//      工具名是本产品的内部术语，出现在第一屏等于把学习成本推给客户。

import type { IconName } from './Icon.js';

/** 一条入门示例。 */
export interface StarterTask {
  /** 短标签（按钮上显示）。 */
  readonly label: string;
  /** 图标名（**必须**是 `models/Icon.ts` 里登记过的名字——`iconPolicy.test.mjs` 会拦下未登记的图标）。 */
  readonly icon: IconName;
  /** 点一下填进输入框的完整任务描述。 */
  readonly prompt: string;
}

/**
 * 中栏空态的「快速开始」示例清单（纯数据 + 只读转发；改动口径见文件头注释）。
 */
export class StarterTasks {
  /**
   * 全部入门示例（顺序即展示顺序）。
   *
   * 刻意是**常量**而非函数：内容不随工作区/模型变化，故不必算、也不该算——
   * 变化会带来"为什么我这里少一条"的困惑，而示例的价值在稳定。
   * @returns 示例清单（只读）
   */
  public static list(): readonly StarterTask[] {
    return StarterTasks.ITEMS;
  }

  /** 示例数据（唯一来源；`list()` 只读转发）。 */
  private static readonly ITEMS: readonly StarterTask[] = [
    {
      label: '读文件并总结',
      icon: 'file',
      prompt: '读取工作区里的 README.md，用中文给我 5 行以内的摘要，并指出它最想解决的问题是什么。',
    },
    {
      label: '跑一条命令',
      icon: 'command',
      prompt: '运行命令 `node -v`，把输出原样告诉我，并说明这个 Node 版本是否符合本项目的 engines 要求。',
    },
    {
      label: '搜索代码',
      icon: 'search',
      prompt: '在工作区里搜索所有 TODO 注释，按文件分组列出（文件路径 + 行号 + 原文），不要修改任何文件。',
    },
    {
      label: '写个小程序',
      icon: 'pencil',
      prompt: '在工作区新建 examples/hello.js，内容是打印当前时间，然后运行它并贴出输出。',
    },
  ];
}
