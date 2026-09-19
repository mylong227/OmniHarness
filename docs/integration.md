# OmniHarness 接入指南

三步接入任意 AI / 软件服务。核心原则：**实现端口接口 → 注入配置 → 完成**，不修改任何核心代码。

## 1. 接入任意 AI（实现 ModelPort）

```ts
import type { ModelPort, ModelRequest, ModelOutput } from 'omniharness';

export class MyModel implements ModelPort {
  readonly name = 'my-model';

  async generate(request: ModelRequest): Promise<ModelOutput> {
    // 调你的模型服务，返回统一输出
    return { text: '回答', toolCalls: [{ id: 't1', name: 'shell', arguments: { command: 'ls' } }] };
  }
}
```

```ts
import { ConfigFactory, createRuntime, Agent, MemoryStorage } from 'omniharness';

const config = ConfigFactory.build({
  workspaceRoot: process.cwd(),
  maxSteps: 16,
  model: new MyModel(), // ← 你的模型即插即用
  storage: new MemoryStorage(),
});
const agent = new Agent(createRuntime.create(config));
```

内置备选：`MockModel`（离线）、`OpenAiCompatibleModel`（任意兼容端点）、`AnthropicModel`。

## 2. 接入任意软件服务（实现 ToolPort）

```ts
import type { ToolPort, ToolCall, ToolContext, ToolResult, ToolDefinition } from 'omniharness';

export class MyServiceTool implements ToolPort {
  readonly name = 'my-service';

  list(): readonly ToolDefinition[] {
    return [
      {
        name: 'my_api',
        description: '调用我的服务',
        parameters: { type: 'object', properties: {} },
      },
    ];
  }

  async execute(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    // 调你的服务（HTTP/数据库/内部 API）
    return { callId: call.id, ok: true, output: '服务返回结果' };
  }
}
```

```ts
const config = ConfigFactory.build({
  workspaceRoot: process.cwd(),
  maxSteps: 16,
  model: new MockModel(),
  storage: new MemoryStorage(),
  tools: new MyServiceTool(), // ← 你的服务成为 agent 工具
});
```

也可用 CLI 热加载：`omniharness exec --prompt "..." --tool ./myTool.js`（模块导出 `{ definition, handler }` 或 ToolPort）。

## 3. 接入自定义审批 / 沙箱 / 存储

```ts
import type { ApprovalPort, ApprovalRequest } from 'omniharness';

export class ManualApproval implements ApprovalPort {
  readonly name = 'manual';
  async decide(request: ApprovalRequest) {
    // 例如：危险命令问人，其余放行
    return request.target.startsWith('rm ') ? 'deny' : 'allow';
  }
}
```

```ts
const config = ConfigFactory.build({
  workspaceRoot: process.cwd(),
  maxSteps: 16,
  model: new MockModel(),
  storage: new MemoryStorage(),
  approvals: new ManualApproval(), // 审批端口替换
  sandbox: new PolicySandbox({ workspaceRoot: process.cwd() }), // 沙箱端口替换
});
```

## 4. 作为服务被调用（app-server）

```bash
# stdio JSON-RPC（给其他进程/SDK）
omniharness server --model-adapter openai --base-url ... --api-key ...

# HTTP + Web UI（浏览器）
omniharness serve --port 8787 --model-adapter openai --base-url ... --api-key ...
```

```bash
# 生成 TS / Python SDK
omniharness schema --out-ts sdk/client.ts --out-py sdk/client.py
```

SDK 客户端注入任意 transport（stdio 子进程 / HTTP）：

```ts
import { OmniHarnessClient } from './sdk/client';
const client = new OmniHarnessClient(async (method, params) => /* 你的 RPC 调用 */);
const { threadId } = await client.threadsCreate('帮我写个脚本');
```

## 5. 常用 CLI

```bash
omniharness exec --prompt "任务"                 # 单次执行
omniharness exec --prompt "..." --resume <id>   # 续跑
omniharness exec --prompt "..." --fork <id>     # 分叉
omniharness session list --storage-dir DIR      # 会话列表
omniharness doctor --model-adapter mock         # 环境诊断
omniharness plugin load --file plugin.js        # 动态加载插件
```

## 6. 配置驱动（omniharness.json）

```json
{
  "modelAdapter": "openai",
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat",
  "storageAdapter": "jsonl",
  "storageDir": "sessions",
  "approval": "guardian",
  "sandbox": "policy",
  "maxSteps": 32,
  "skills": [
    {
      "name": "repo-conventions",
      "description": "本仓库编码约定",
      "instructions": "改代码前先读 AGENTS.md；提交信息用「类型(范围): 摘要」。",
      "tags": ["约定"]
    }
  ]
}
```

配置文件在 cwd 向上逐级查找；CLI 参数优先于配置。

### 6.1 受种技能（skills）

技能是**声明式能力包**：命中技能名或其任一 `tag` 时，`instructions` 会作为 system 事件注入该会话
（命中即注入，不命中零噪声）。两条输入通道，用同一份校验：

- 配置文件内联：上例的 `skills: [...]`；
- CLI 旗标：`omniharness --skills path/to/skills.json "..."`（可重复；文件内容为数组，
  或 `{"skills": [...]}`）。

合并语义：内联在前、旗标在后，**同名以旗标为准**（技能注册表对重名直接抛错，故此处显式去重）。
每条技能必须给全 `name` / `description` / `instructions`（非空），`tags` 可选；缺失或重名会
**fail-closed** 报错并指出位置（如 `omniharness.json: skills[0].instructions 必须是非空字符串`）。
只接受声明式子集——莫尔组合、相变固化等运行时字段不能由配置注入（避免伪造「这技能是涌现/固化来的」）。
