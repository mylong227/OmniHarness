import type { FieldSchema, MethodSchema, ProtocolSchema } from './protocolSchema.js';

/**
 * @beta
 * 代码生成器：由同一 schema 生成 TS / Python 客户端 / 协议文档。
 */
export class CodeGenerator {
  /**
   * 生成 TS 客户端代码（含流式订阅）。
   * @param schema 协议 schema 单一事实源，包含全部方法、参数、结果与流事件定义。
   * @returns 可直接写入 .ts 文件的完整 OmniHarnessClient 源码字符串。
   */
  public generateTs(schema: ProtocolSchema): string {
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

  /**
   * 生成协议文档（markdown）。
   * @param schema 协议 schema 单一事实源，方法描述与字段说明直接来源于此。
   * @returns 完整的 markdown 协议文档字符串（方法一览表 + 逐方法详情）。
   */
  public generateDocs(schema: ProtocolSchema): string {
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

  /**
   * 生成 Python 客户端代码（含流式订阅）。
   * @param schema 协议 schema 单一事实源，与 generateTs 使用同一份定义以保证三端一致。
   * @returns 可直接写入 .py 文件的完整 OmniHarnessClient 源码字符串。
   */
  public generatePython(schema: ProtocolSchema): string {
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

  /**
   * 生成 TS 方法。
   * @param method 单个方法的 schema 定义（名称、参数、结果字段）。
   * @returns 该方法对应的 TS 客户端成员源码片段（JSDoc + 签名 + 调用体）。
   */
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

  /**
   * 生成 TS 流式方法（订阅期间推送的事件，结束后自动取消订阅）。
   * @param method 单个方法的 schema 定义，流事件名取自 method.stream.event。
   * @returns 该方法对应的 TS 流式成员源码片段（`xxxStream` 形式）。
   */
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

  /**
   * TS 请求体。
   * @param method 单个方法的 schema 定义，字段名保持 wire 原名。
   * @returns 形如 `{ field: camelField }` 的请求对象字面量字符串；无参数时为 `{}`。
   */
  private tsBody(method: MethodSchema): string {
    const names = Object.keys(method.params);
    if (names.length === 0) {
      return '{}';
    }
    return `{ ${names.map((name) => `${name}: ${this.camel(name)}`).join(', ')} }`;
  }

  /**
   * TS 结果类型。
   * @param method 单个方法的 schema 定义，result 字段决定可选性（required=false → `?`）。
   * @returns 形如 `{ field?: type; ... }` 的 TS 类型字面量字符串。
   */
  private tsResultType(method: MethodSchema): string {
    const fields = Object.entries(method.result).map(
      ([name, field]) => `${name}${field.required ? '' : '?'}: ${this.tsType(field)}`,
    );
    return `{ ${fields.join('; ')} }`;
  }

  /**
   * TS 标量类型。
   * @param field 字段 schema，仅含 type 标量映射。
   * @returns 对应的 TS 类型名（array → `unknown[]`，object/未知 → `Record<string, unknown>`）。
   */
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

  /**
   * 生成单方法文档。
   * @param method 单个方法的 schema 定义，描述与字段说明直接取自 schema。
   * @returns 该方法的 markdown 章节字符串（标题、流式说明、参数表、结果表）。
   */
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

  /**
   * 生成 Python 方法。
   * @param method 单个方法的 schema 定义（名称、参数、结果字段）。
   * @returns 该方法对应的 Python 客户端成员源码片段（snake_case 签名 + 调用体）。
   */
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

  /**
   * 生成 Python 流式方法（订阅期间推送的事件，结束后自动取消订阅）。
   * @param method 单个方法的 schema 定义，流事件名取自 method.stream.event。
   * @returns 该方法对应的 Python 流式成员源码片段（`xxx_stream` 形式，finally 中退订）。
   */
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

  /**
   * Python 请求体。
   * @param method 单个方法的 schema 定义，字段名保持 wire 原名、值用蛇形局部变量。
   * @returns 形如 `{'field': snake_field}` 的请求字典字面量字符串；无参数时为 `{}`。
   */
  private pyBody(method: MethodSchema): string {
    const names = Object.keys(method.params);
    if (names.length === 0) {
      return '{}';
    }
    return `{${names.map((name) => `'${name}': ${this.camelToSnake(name)}`).join(', ')}}`;
  }

  /**
   * Python 标量类型。
   * @param field 字段 schema，仅含 type 标量映射。
   * @returns 对应的 Python 类型注解（array → `list`，object/未知 → `dict`）。
   */
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

  /**
   * 点号方法名转驼峰。
   * @param methodName wire 协议方法名（如 `session.create`）。
   * @returns TS 客户端成员名（如 `sessionCreate`）；无点号时原样返回。
   */
  private camel(methodName: string): string {
    const [namespace, action] = methodName.split('.');
    if (action === undefined) {
      return methodName;
    }
    return `${namespace}${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  }

  /**
   * 点号方法名转蛇形。
   * @param methodName wire 协议方法名（如 `session.create`）。
   * @returns Python 客户端成员名（如 `session_create`）。
   */
  private snake(methodName: string): string {
    return methodName.replace('.', '_');
  }

  /**
   * 驼峰转蛇形（Python 参数名）。
   * @param name wire 协议参数名（可能含驼峰，如 `threadId`）。
   * @returns snake_case 形式的 Python 参数名（如 `thread_id`）。
   */
  private camelToSnake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  }
}
