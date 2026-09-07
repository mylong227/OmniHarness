# OmniHarness 插件开发指南

> 插件让你**不改任何核心代码**就能给 Agent 加工具、接服务、扩生态。
> 一个插件 = 一个目录，含 `omni.plugin.json`（清单）+ 入口文件（默认 `index.js`）。
> 加载时 `apply(ctx)` 被调用，插件通过 `ctx.services.get('port.xxx')` 向宿主注册能力。

## 1. 插件结构

```
my-plugin/
├── omni.plugin.json   # 清单（必须）
└── index.js           # 入口（默认；可由 manifest.entry 改）
```

## 2. 清单字段（`src/plugin/manifest.ts` 的 `PluginManifest`）

| 字段          | 必填 | 说明                                                      |
| ------------- | ---- | --------------------------------------------------------- |
| `name`        | ✅   | 唯一名，小写连字符，如 `github-tools`                     |
| `version`     | ✅   | 语义化版本                                                |
| `description` | ⬜   | 一句话描述                                                |
| `author`      | ⬜   | 作者                                                      |
| `homepage`    | ⬜   | 主页/源码地址                                             |
| `permissions` | ⬜   | 权限声明数组（**必须在白名单内**，否则 fail-closed 拒绝） |
| `entry`       | ⬜   | 入口文件，相对插件目录，默认 `index.js`                   |
| `source`      | ⬜   | 标记 `bundled` / `local` / `remote`，用于 UI/CLI 展示     |

## 3. 权限白名单（`src/plugin/permission.ts`）

共 10 项，未声明 = 无能力；超白名单 = 安装/加载即拒（fail-closed）：

| 权限          | 含义         | 危险 |
| ------------- | ------------ | ---- |
| `fs.read`     | 读工作区文件 |      |
| `fs.write`    | 写文件       | ⚠️   |
| `fs.delete`   | 删文件       | ⚠️   |
| `net.connect` | 出站网络     |      |
| `net.listen`  | 监听端口     | ⚠️   |
| `proc.exec`   | 执行进程     | ⚠️   |
| `env.read`    | 读环境变量   |      |
| `env.write`   | 写环境变量   | ⚠️   |
| `store.read`  | 读 KV/存储   |      |
| `store.write` | 写 KV/存储   | ⚠️   |

危险权限在 Web 市场 UI 中高亮，安装时显式提示，但非阻断。

## 4. 入口 `apply(ctx)` 模式

```js
// examples/plugins/hello-tool/index.js（精简）
export default {
  meta: { name: 'hello-tool', inject: ['port.tools'] },
  apply(ctx) {
    const tools = ctx.services.get('port.tools');
    tools.register(
      {
        name: 'hello',
        description: '示例工具：回问候语',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '被问候者' } },
        },
      },
      async (call) => ({
        callId: call.id,
        ok: true,
        output: `hello, ${call.arguments.name ?? 'world'}!`,
      }),
    );
  },
};
```

- `meta.inject`：声明依赖的端口（用于依赖排序与可用性检查），如 `['port.tools', 'port.kv']`。
- `ctx.services.get('port.tools')` 返回 `ToolPort`，`.register(spec, handler)` 把工具挂进 Agent 工具表。
- `handler(call)` 返回 `{ callId, ok, output }`；`call.arguments` 即模型传入参数。

## 5. 完整示例：hello-tool 逐行讲解

**`omni.plugin.json`**

```json
{
  "name": "hello-tool",
  "version": "0.1.0",
  "description": "示例工具插件：注册 hello 工具，验证插件闭环（无敏感权限）",
  "author": "OmniHarness Samples",
  "permissions": [],
  "entry": "index.js",
  "source": "bundled"
}
```

- `permissions: []`：该插件不请求任何敏感能力，最安全。
- `entry: "index.js"`：入口文件名。

**`index.js`**（见第 4 节）。加载后模型即可直接调用 `hello` 工具——这就是「插件闭环」：安装 → serve 自动加载（或 UI 点「重新加载」）→ 工具对 Agent 可见。

## 6. 本地调试

```bash
# 方式 A：直接挂单个工具模块（不经插件系统）
node dist/src/cli/exec.js --prompt "..." --tool ./my-plugin/index.js

# 方式 B：放进插件目录，serve 启动自动加载
# 默认目录：~/.omniharness/plugins  或  serve --dir ./my-plugins
node dist/src/cli/exec.js serve --port 8787 --dir ./my-plugins

# 方式 C：市场安装后热加载
# Web UI 插件市场「安装」→ 点「重新加载」(plugins.reload RPC)
```

远程源（由 catalog 提供的插件）走 `node:vm` 受限上下文隔离加载（best-effort；彻底不可信代码应放独立进程/Worker + OS 级沙箱）。

## 7. registry / catalog 接入

`examples/catalog/registry.json` 是**文件源占位服务**（与 `RemoteHttpSource` 同 schema）。
直接编辑该 JSON 即可扩展市场，无需改代码：

```json
{
  "plugins": [
    {
      "manifest": { "name": "demo-notes", "version": "0.1.0", "permissions": [] },
      "installFrom": { "kind": "path", "path": "examples/plugins/demo-notes" },
      "source": "local"
    }
  ]
}
```

`PluginRegistry` 默认源顺序 = 本地 > 内置 > 文件占位 > 远程。

## 8. 打包发布（Profile + Bundle）

- **Profile（命名插件组合）**：`PluginProfileStore` 存于 `.omniharness/pluginProfiles/<id>.json`，CLI `serve --plugin-profile coding` 一键把运行时插件集收敛为该命名组合。
- **Bundle（可 patch 发布单元）**：零依赖 store-zip + `BundleManifest` + HMAC-SHA256 签名校验；`bundle.pack` / `bundle.unpack` RPC。补丁层 `config` 覆盖实现配置叠加。

## 9. 校验与 fail-closed

- 清单权限越白名单 → 安装/加载阶段即拒。
- 未知权限字符串 → 抛错中断。
- 单插件加载坏不影响其余（onError 回调上报后继续）。
- 远程源不可信代码 → VM 受限上下文加载，不注入 `require`/`process`/`fetch`。

> 设计原则：插件系统复用全部既有门禁（审批 → 沙箱 → 执行 → 记录），零新增运行时依赖。
