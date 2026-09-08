/**
 * 示例插件：demo-calc —— 一个插件注册多个纯计算工具。
 *
 * 演示要点（区别于 hello-tool / demo-notes）：
 *  1. 单个 apply 内可注册多个工具（calc_sum / calc_stats）；
 *  2. 每个工具独立声明参数 schema 并做输入校验，带明确报错；
 *  3. 纯本地计算，无需 fs/network 等敏感权限（permissions: []），
 *     最小化安装面，适合作为新插件作者的起点模板。
 *
 * 闭环：catalog 安装 → serve 启动加载 → 工具挂进 Agent 工具表 → 模型可直接调用。
 */
export default {
  meta: {
    name: 'demo-calc',
    version: '0.1.0',
    description: '示例插件：注册 calc_sum / calc_stats 两个纯计算工具（无敏感权限）',
    permissions: [],
    inject: ['port.tools'],
  },

  apply(ctx) {
    const tools = ctx.services.get('port.tools');

    // ---- 参数校验辅助：把入参规整成 number[]，非法即抛错 ----
    function toNumbers(raw, what) {
      if (!Array.isArray(raw)) {
        throw new Error(
          what + `: 参数 numbers 必须是数组，收到 ` + (Array.isArray(raw) ? '非数组值' : typeof raw),
        );
      }
      const nums = raw.map(Number);
      if (nums.some((n) => !Number.isFinite(n))) {
        throw new Error(what + ': numbers 中存在无法转换为有限数字的元素');
      }
      if (nums.length === 0) {
        throw new Error(what + ': numbers 不能为空数组');
      }
      return nums;
    }

    tools.register(
      {
        name: 'calc_sum',
        description: '对传入的数字数组求和（demo-calc 插件，演示多工具注册）',
        parameters: {
          type: 'object',
          properties: {
            numbers: {
              type: 'array',
              items: { type: 'number' },
              description: '要求和的数字，如 [1, 2, 3]',
            },
          },
          required: ['numbers'],
        },
      },
      async (call) => {
        const nums = toNumbers(call.arguments?.numbers, 'calc_sum');
        const sum = nums.reduce((a, b) => a + b, 0);
        return {
          callId: call.id,
          ok: true,
          output: { sum, count: nums.length, numbers: nums },
        };
      },
    );

    tools.register(
      {
        name: 'calc_stats',
        description: '计算数字数组的 min / max / 均值 / 中位数（demo-calc 插件）',
        parameters: {
          type: 'object',
          properties: {
            numbers: {
              type: 'array',
              items: { type: 'number' },
              description: '待统计的数字，如 [4, 1, 7, 2]',
            },
          },
          required: ['numbers'],
        },
      },
      async (call) => {
        const nums = toNumbers(call.arguments?.numbers, 'calc_stats');
        const sorted = [...nums].sort((a, b) => a - b);
        const n = sorted.length;
        const mid = Math.floor(n / 2);
        const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        const mean = sorted.reduce((a, b) => a + b, 0) / n;
        return {
          callId: call.id,
          ok: true,
          output: {
            min: sorted[0],
            max: sorted[n - 1],
            mean,
            median,
            count: n,
            sorted,
          },
        };
      },
    );
  },
};
