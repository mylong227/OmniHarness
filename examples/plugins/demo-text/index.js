/**
 * 示例插件：demo-text —— 文本处理类纯计算工具。
 *
 * 演示要点（在 demo-calc 基础上再进一步）：
 *  1. 覆盖 string / array 两种入参形态（text 字符串、words 数组）的工具注册；
 *  2. 更完整的输入校验：类型、长度上限、转换模式枚举，错误信息带工具名；
 *  3. 仍然是纯本地计算、零敏感权限（permissions: []），可直接作为写业务插件的模板。
 *
 * 闭环：catalog 安装 -> serve 启动加载 -> 工具挂进 Agent 工具表 -> 模型可直接调用。
 * 安装命令参考：omni plugin install demo-text（离线目录）。
 */
export default {
  meta: {
    name: 'demo-text',
    version: '0.1.0',
    description: '示例插件：注册 text_stats / text_case 两个文本处理工具（无敏感权限）',
    permissions: [],
    inject: ['port.tools'],
  },

  apply(ctx) {
    const tools = ctx.services.get('port.tools');

    // ---- 输入校验辅助 ----
    const MAX_LEN = 10000;

    function readText(raw) {
      const text = raw && raw.text;
      if (typeof text !== 'string') {
        throw new Error('text_stats: 参数 text 必须是字符串，收到 ' + typeof text);
      }
      if (text.length > MAX_LEN) {
        throw new Error('text_stats: text 超长（上限 ' + MAX_LEN + ' 字符）');
      }
      return text;
    }

    function toWords(raw) {
      const words = raw && raw.words;
      if (!Array.isArray(words)) {
        throw new Error('text_case: 参数 words 必须是字符串数组，收到 ' + typeof words);
      }
      if (words.length === 0) throw new Error('text_case: words 不能为空数组');
      const clean = words.map((w) => String(w));
      if (clean.some((w) => w.length === 0 || w.length > 100)) {
        throw new Error('text_case: words 中每个元素长度须在 1..100 之间');
      }
      return clean;
    }

    // ---- 工具 1：text_stats（字符 / 词 / 行 / 词频统计） ----
    tools.register(
      {
        name: 'text_stats',
        description:
          '统计文本字符数（含 / 不含空白）、词数、行数以及 Top N 高频词（demo-text 插件）',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '待统计的文本' },
            topK: { type: 'number', description: '返回的高频词条数（默认 5，最大 20）' },
          },
          required: ['text'],
        },
      },
      async (call) => {
        const text = readText(call.arguments);
        const topK = Math.min(Math.max(Number(call.arguments && call.arguments.topK) || 5, 1), 20);

        const chars = [...text];
        const charsNoSpace = chars.filter((c) => !/\s/.test(c)).length;
        const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
        const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0).length;

        const freq = new Map();
        for (const w of words) {
          const key = w.toLowerCase();
          freq.set(key, (freq.get(key) || 0) + 1);
        }
        const top = [...freq.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, topK)
          .map(([word, count]) => ({ word, count }));

        return {
          callId: call.id,
          ok: true,
          output: { chars: chars.length, charsNoSpace, words: words.length, lines, topWords: top },
        };
      },
    );

    // ---- 工具 2：text_case（批量大小写转换） ----
    tools.register(
      {
        name: 'text_case',
        description: '对一批单词做 upper / lower / title 大小写转换（demo-text 插件）',
        parameters: {
          type: 'object',
          properties: {
            words: { type: 'array', items: { type: 'string' }, description: '待转换的单词数组' },
            mode: {
              type: 'string',
              enum: ['upper', 'lower', 'title'],
              description: '转换模式，默认 upper',
            },
          },
          required: ['words'],
        },
      },
      async (call) => {
        const clean = toWords(call.arguments);
        const mode = call.arguments && call.arguments.mode ? call.arguments.mode : 'upper';
        if (['upper', 'lower', 'title'].indexOf(mode) === -1) {
          throw new Error('text_case: mode 仅支持 upper / lower / title，收到 ' + mode);
        }

        let convert;
        if (mode === 'upper') convert = (w) => w.toUpperCase();
        else if (mode === 'lower') convert = (w) => w.toLowerCase();
        else
          convert = (w) =>
            w.replace(/(^|[\s\-_/])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());

        return {
          callId: call.id,
          ok: true,
          output: { mode, count: clean.length, converted: clean.map(convert) },
        };
      },
    );
  },
};
