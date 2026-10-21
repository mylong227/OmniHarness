#!/usr/bin/env node
/**
 * Plugin Worker 入口（ADR-0012，协议 v1）。
 *
 * 这是**不可信插件代码的唯一执行宿主**：它只通过 stdin/stdout 的 NDJSON 协议与父进程通信，
 * 不接收宿主对象，也不把父进程的 secrets 放进环境。进程边界是安全边界；OS 沙箱由父进程
 * 在 spawn 时施加（见 ADR-0012 §7）。
 */
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

/** 单帧上限（与父进程一致）。 */
const MAX_FRAME_BYTES = 1024 * 1024;

class PluginWorker {
  constructor() {
    this.session = process.env['OMNI_PLUGIN_WORKER_SESSION'] ?? '';
    this.nonce = '';
    this.plugin = undefined;
    this.handlers = new Map();
    this.toolHandlers = new Map();
    this.handlerSeq = 0;
    this.ready = false;
    this.activateStarted = false;
  }

  /** 发送一条协议消息。 */
  send(message) {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      return;
    }
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      /* 父进程已关闭：退出由 exit 事件处理。 */
    }
  }

  /** 发送事件。 */
  event(method, params) {
    this.send({ v: 1, session: this.session, kind: 'evt', method, params });
  }

  /** 响应请求。 */
  respond(id, ok, payload) {
    if (ok) {
      this.send({ v: 1, session: this.session, kind: 'res', id, ok: true, result: payload });
    } else {
      this.send({
        v: 1,
        session: this.session,
        kind: 'res',
        id,
        ok: false,
        error: { code: 'INVALID_FRAME', message: String(payload) },
      });
    }
  }

  /** 把插件 console 输出改走 stderr/日志，避免污染协议 stdout。 */
  installConsole() {
    const emit = (...args) => {
      this.event('log', { level: 'info', message: args.map((a) => String(a)).join(' ') });
    };
    console.log = emit;
    console.info = emit;
    console.debug = emit;
  }

  /** 工具注册视图（v2 SDK 与 legacy apply 共用）。 */
  toolsView() {
    return {
      list: () => [],
      register: (definition, handler) => {
        if (typeof definition?.name !== 'string' || typeof handler !== 'function') {
          throw new Error('INVALID_TOOL: register 需要 definition.name 与 handler');
        }
        const handlerId = `h_${++this.handlerSeq}`;
        this.handlers.set(handlerId, handler);
        this.toolHandlers.set(definition.name, handlerId);
        this.event('tool.register', { definition, handler: handlerId });
      },
    };
  }

  /** SDK v2 上下文：只有工具注册；其它能力在 v1 一律不可用。 */
  contextV2() {
    return {
      tools: this.toolsView(),
      log: (...args) => this.event('log', { level: 'info', message: args.map(String).join(' ') }),
    };
  }

  /** Legacy apply 上下文：仅 port.tools 的注册视图；容器不跨进程。 */
  contextLegacy() {
    const tools = this.toolsView();
    return {
      services: {
        get: (name) => {
          if (name === 'port.tools') return tools;
          throw new Error(`CAPABILITY_UNAVAILABLE: ${String(name)} 不在远程插件能力白名单内`);
        },
        has: (name) => name === 'port.tools',
        register: () => {
          throw new Error('CAPABILITY_UNAVAILABLE: 远程插件不能注册宿主服务');
        },
        overwrite: () => {
          throw new Error('CAPABILITY_UNAVAILABLE: 远程插件不能覆盖宿主服务');
        },
      },
      onService: () => {
        throw new Error('CAPABILITY_UNAVAILABLE: 远程插件不支持 onService');
      },
      registerService: () => {
        throw new Error('CAPABILITY_UNAVAILABLE: 远程插件不能注册服务');
      },
    };
  }

  /** 加载插件模块。 */
  async loadPlugin() {
    const entry = process.env['OMNI_PLUGIN_ENTRY'] ?? '';
    if (entry === '') {
      throw new Error('SANDBOX_UNAVAILABLE: 缺少 OMNI_PLUGIN_ENTRY');
    }
    const module = await import(`${pathToFileURL(entry).href}?worker=1`);
    const plugin = module.default;
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.meta?.name !== 'string') {
      throw new Error('INVALID_TOOL: 默认导出必须是 { meta, activate|apply }');
    }
    if (typeof plugin.activate !== 'function' && typeof plugin.apply !== 'function') {
      throw new Error('INVALID_TOOL: 插件缺少 activate() 或 apply()');
    }
    this.plugin = plugin;
  }

  /** 激活插件。 */
  async activate() {
    if (this.activateStarted) return;
    this.activateStarted = true;
    if (typeof this.plugin.activate === 'function') {
      await this.plugin.activate(this.contextV2());
      return;
    }
    await this.plugin.apply(this.contextLegacy());
  }

  /** 停用插件（幂等）。 */
  async deactivate() {
    if (typeof this.plugin?.deactivate === 'function') {
      await this.plugin.deactivate();
    } else if (typeof this.plugin?.effect === 'function') {
      await this.plugin.effect();
    }
  }

  /** 处理工具调用。 */
  async invoke(params) {
    const handlerId = this.toolHandlers.get(params?.tool);
    if (handlerId === undefined) {
      return { callId: String(params?.callId ?? ''), ok: false, error: 'INVALID_TOOL: 未知工具' };
    }
    const handler = this.handlers.get(handlerId);
    if (handler === undefined) {
      return { callId: String(params?.callId ?? ''), ok: false, error: 'INVALID_TOOL: 处理器缺失' };
    }
    const call = {
      id: String(params?.callId ?? ''),
      name: String(params?.tool ?? ''),
      arguments: params?.args ?? {},
    };
    const context = params?.context ?? { sessionId: '', workspaceRoot: '' };
    try {
      const result = await handler(call, context);
      if (result !== null && typeof result === 'object') {
        return { ...result, callId: result.callId ?? call.id };
      }
      return { callId: call.id, ok: true, output: String(result ?? '') };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 处理一条入站消息。 */
  async onMessage(message) {
    if (message?.kind === 'hello') {
      if (message.v !== 1 || message.session !== this.session) {
        throw new Error('VERSION_MISMATCH: 握手版本/会话不匹配');
      }
      this.nonce = message.nonce;
      await this.loadPlugin();
      this.ready = true;
      this.event('ready', { nonce: this.nonce, pid: process.pid, sdk: '1' });
      return;
    }
    if (message?.kind !== 'req') return;
    try {
      if (message.method === 'plugin.activate') {
        await this.activate();
        this.respond(message.id, true, { ok: true });
        return;
      }
      if (message.method === 'plugin.deactivate') {
        await this.deactivate();
        this.respond(message.id, true, { ok: true });
        return;
      }
      if (message.method === 'tool.invoke') {
        this.respond(message.id, true, await this.invoke(message.params));
        return;
      }
      if (message.method === 'tool.cancel') {
        this.respond(message.id, true, { cancelled: true });
        return;
      }
      if (message.method === 'health.ping') {
        this.respond(message.id, true, { ready: this.ready, pid: process.pid });
        return;
      }
      this.respond(message.id, false, `UNSUPPORTED_METHOD: ${String(message.method)}`);
    } catch (error) {
      this.respond(message.id, false, error instanceof Error ? error.message : String(error));
    }
  }

  /** 启动读循环。 */
  run() {
    this.installConsole();
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > MAX_FRAME_BYTES) {
        process.exit(3);
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.exit(4);
      }
      void this.onMessage(message);
    });
    rl.on('close', () => process.exit(0));
    process.on('uncaughtException', (error) => {
      this.event('fault', { code: 'WORKER_CRASHED', message: error.message });
      process.exit(1);
    });
    process.on('unhandledRejection', (error) => {
      this.event('fault', { code: 'WORKER_CRASHED', message: String(error) });
      process.exit(1);
    });
  }
}

new PluginWorker().run();
