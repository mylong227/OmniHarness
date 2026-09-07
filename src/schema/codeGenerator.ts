import type { FieldSchema, MethodSchema, ProtocolSchema } from './protocolSchema.js';

/**
 * @beta
 * 代码生成器：由同一 schema 生成 TS / Python 客户端 / 协议文档。
 */
export class CodeGenerator {
  /** 生成 TS 客户端代码（含流式订阅）。 */
  generateTs(schema: ProtocolSchema): string {
    const methods = schema.methods.map((method) => this.tsMethod(method)).join('\n\n  ');
    const streams = schema.methods
      .filter((method) => method.stream !== undefined)
      .map((method) => this.tsStreamMethod(method));
    const blocks = [
      '/** 由 OmniHarness protocol schema 自动生成（勿手改）。 */',
      'export type Subscription = () => void;',
      '',
      'export class OmniHarnessClient {',
      '  constructor(',
      '    private readonly call: <T>(method: string, params: Record<string, unknown>) => Promise<T>,',
      '    private readonly subscribe: (event: string, handler: (params: Record<string, unknown>) => void) => Subscription,',
      '  ) {}',
      '',
      '  /** 订阅服务端通知，返回取消订阅函数。 */',
      '  on(event: string, handler: (params: Record<string, unknown>) => void): Subscription {',
      '    return this.subscribe(event, handler);',
      '  }',
      '',
      methods,
    ];
    if (streams.length > 0) {
      blocks.push('', streams.join('\n\n'));
    }
    blocks.push('}', '');
    return blocks.join('\n');
  }

  /** 生成协议文档（markdown）。 */
  generateDocs(schema: ProtocolSchema): string {
    const overview = [
      `# OmniHarness 协议文档（${schema.jsonrpc}）`,
      '',
      '> 由单源 schema 自动生成（勿手改）。传输：stdio（行式 JSON）/ HTTP+SSE / WebSocket。',
      '',
      '## 方法一览',
      '',
      '| 方法 | 说明 |',
      '|---|---|',
      ...schema.methods.map((method) => `| \`${method.name}\` | ${method.description} |`),
      '',
      '## 方法详情',
      '',
    ];
    const details = schema.methods.map((method) => this.docMethod(method)).join('\n\n');
    return [...overview, details, ''].join('\n');
  }

  /** 生成 Python 客户端代码（含流式订阅）。 */
  generatePython(schema: ProtocolSchema): string {
    const methods = schema.methods.map((method) => this.pyMethod(method)).join('\n\n    ');
    const streams = schema.methods
      .filter((method) => method.stream !== undefined)
      .map((method) => this.pyStreamMethod(method));
    const blocks = [
      '"""由 OmniHarness protocol schema 自动生成（勿手改）。"""',
      'class OmniHarnessClient:',
      '    def __init__(self, call, subscribe):',
      '        self._call = call',
      '        self._subscribe = subscribe',
      '',
      '    def on(self, event: str, handler) -> callable:',
      '        """订阅服务端通知，返回取消订阅函数。"""',
      '        return self._subscribe(event, handler)',
      '',
      methods,
    ];
    if (streams.length > 0) {
      blocks.push('', streams.join('\n\n'));
    }
    blocks.push('', '');
    return blocks.join('\n');
  }

  /** 生成 TS 方法。 */
  private tsMethod(method: MethodSchema): string {
    const params = Object.keys(method.params);
    const signature = params
      .map(
        (name) => `${this.camel(name)}: ${this.tsType(method.params[name] ?? { type: 'string' })}`,
      )
      .join(', ');
    const body = this.tsBody(method);
    return [
      `  /** ${method.description} */`,
      `  ${this.camel(method.name)}(${signature}): Promise<${this.tsResultType(method)}> {`,
      `    return this.call('${method.name}', ${body});`,
      '  }',
    ].join('\n');
  }

  /** 生成 TS 流式方法（订阅期间推送的事件，结束后自动取消订阅）。 */
  private tsStreamMethod(method: MethodSchema): string {
    const params = Object.keys(method.params);
    const signature = params
      .map(
        (name) => `${this.camel(name)}: ${this.tsType(method.params[name] ?? { type: 'string' })}`,
      )
      .join(', ');
    const event = method.stream?.event ?? 'thread.event';
    return [
      `  /** ${method.description} —— 流式版（订阅 \`${event}\`）。 */`,
      `  ${this.camel(method.name)}Stream(${signature}, onEvent: (params: Record<string, unknown>) => void): Promise<${this.tsResultType(method)}> {`,
      `    const off = this.subscribe('${event}', onEvent);`,
      `    return this.call('${method.name}', ${this.tsBody(method)}).finally(off);`,
      '  }',
    ].join('\n');
  }

  /** TS 请求体。 */
  private tsBody(method: MethodSchema): string {
    const names = Object.keys(method.params);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${name}: ${this.camel(name)}`).join(', ')} }`;
  }

  /** TS 结果类型。 */
  private tsResultType(method: MethodSchema): string {
    const fields = Object.entries(method.result).map(
      ([name, field]) => `${name}${field.required ? '' : '?'}: ${this.tsType(field)}`,
    );
    return `{ ${fields.join('; ')} }`;
  }

  /** TS 标量类型。 */
  private tsType(field: FieldSchema): string {
    switch (field.type) {
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return 'unknown[]';
      default:
        return 'Record<string, unknown>';
    }
  }

  /** 生成单方法文档。 */
  private docMethod(method: MethodSchema): string {
    const lines: string[] = [`### ${method.name}`, '', method.description, ''];
    if (method.stream !== undefined) {
      const note =
        method.stream.description === undefined ? '' : `（${method.stream.description}）`;
      lines.push(
        `> **流式方法**：执行期间持续推送 \`${method.stream.event}\`${note}。SDK 用 \`${this.camel(method.name)}Stream\` / \`${this.snake(method.name)}_stream\` 订阅。`,
        '',
      );
    }
    lines.push('**参数**', '');
    lines.push('| 字段 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
    for (const [name, field] of Object.entries(method.params)) {
      lines.push(
        `| \`${name}\` | ${field.type} | ${field.required === true ? '是' : '否'} | ${field.description ?? ''} |`,
      );
    }
    lines.push('', '**结果**', '');
    lines.push('| 字段 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
    for (const [name, field] of Object.entries(method.result)) {
      lines.push(
        `| \`${name}\` | ${field.type} | ${field.required === true ? '是' : '否'} | ${field.description ?? ''} |`,
      );
    }
    return lines.join('\n');
  }

  /** 生成 Python 方法。 */
  private pyMethod(method: MethodSchema): string {
    const params = Object.keys(method.params);
    const signature = params
      .map(
        (name) =>
          `${this.camelToSnake(name)}: ${this.pyType(method.params[name] ?? { type: 'string' })}`,
      )
      .join(', ');
    const body = this.pyBody(method);
    return [
      `    def ${this.snake(method.name)}(${signature}) -> dict:`,
      `        """${method.description}"""`,
      `        return self._call('${method.name}', ${body})`,
    ].join('\n');
  }

  /** 生成 Python 流式方法（订阅期间推送的事件，结束后自动取消订阅）。 */
  private pyStreamMethod(method: MethodSchema): string {
    const params = Object.keys(method.params);
    const signature = params
      .map(
        (name) =>
          `${this.camelToSnake(name)}: ${this.pyType(method.params[name] ?? { type: 'string' })}`,
      )
      .join(', ');
    const event = method.stream?.event ?? 'thread.event';
    return [
      `    def ${this.snake(method.name)}_stream(self, ${signature}, on_event) -> dict:`,
      `        """${method.description} —— 流式版（订阅 ${event}）"""`,
      `        off = self._subscribe('${event}', on_event)`,
      '        try:',
      `            return self._call('${method.name}', ${this.pyBody(method)})`,
      '        finally:',
      '            off()',
    ].join('\n');
  }

  /** Python 请求体。 */
  private pyBody(method: MethodSchema): string {
    const names = Object.keys(method.params);
    if (names.length === 0) {
      return '{}';
    }
    return `{${names.map((name) => `'${name}': ${this.camelToSnake(name)}`).join(', ')}}`;
  }

  /** Python 标量类型。 */
  private pyType(field: FieldSchema): string {
    switch (field.type) {
      case 'string':
        return 'str';
      case 'number':
        return 'float';
      case 'boolean':
        return 'bool';
      case 'array':
        return 'list';
      default:
        return 'dict';
    }
  }

  /** 点号方法名转驼峰。 */
  private camel(methodName: string): string {
    const [namespace, action] = methodName.split('.');
    if (action === undefined) {
      return methodName;
    }
    return `${namespace}${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  }

  /** 点号方法名转蛇形。 */
  private snake(methodName: string): string {
    return methodName.replace('.', '_');
  }

  /** 驼峰转蛇形（Python 参数名）。 */
  private camelToSnake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  }
}
