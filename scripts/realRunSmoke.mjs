#!/usr/bin/env node
/**
 * **真实跑测冒烟**（2026-10-06 第五十九轮）：把构建产物当黑盒跑一遍，逐项记录结论。
 *
 * ## 回答什么问题
 *
 * 全量单测（2938 例）证明的是"模块级契约没退化"；本脚本回答另一个问题：
 * **"这台机器上，把软件真的启动起来，各个入口是不是真的能用"**——CLI 子命令矩阵、
 * 单跑回路（含事件落盘 / resume / trace）、身份密码学链路、KV、编排（goal/workflow）、
 * **真实第三方 MCP stdio 链路**、以及 `serve` 的 HTTP/WS/静态页。
 *
 * ## 为什么要有它（与单测的分工）
 *
 * 单测大量使用注入接缝与内存传输；而"装配好的进程能不能起来"是另一类失败（缺资源、路径、
 * 配置分层、TTY、端口、SDK 版本…）。本仓已多次吃到"声明有 ≠ 路径上真的有"，故这里**真起进程**、
 * **真发请求**、**真读回执**，并把每一项的退出码与关键证据写进报告 JSON。
 *
 * ## 用法
 *
 * ```bash
 * npm run build                 # 必须先有 dist/**
 * node scripts/realRunSmoke.mjs --phase=core     # CLI 矩阵 + 单跑回路 + 治理/身份/KV/编排
 * node scripts/realRunSmoke.mjs --phase=mcp      # 真实第三方 MCP stdio 链路
 * node scripts/realRunSmoke.mjs --phase=serve    # web 构建 + serve 的 HTTP/WS/静态页
 * node scripts/realRunSmoke.mjs --phase=all      # 全部（推荐；报告写到 .omniharness/real-run-report.json）
 * ```
 *
 * 退出码：`0` 全部通过（含"按设计跳过"）｜`1` 有项失败（报告里逐项标注）。
 *
 * ## 诚实边界
 *
 * - 在**独立临时工作区**里跑（自带 `omniharness.json`），不污染本仓的 `.omniharness/`；
 * - 模型一律用 `mock`（脚本化响应）——本脚本验的是**软件链路**，不是模型能力；
 * - 需要外部设施的项目（真实 IdP / 真实第三方 A2A 对端 / 官方 SWE-bench）**不在**本脚本范围，
 *   它们在 `docs/COMMERCIALIZATION_GAPS_2026-10.md` 里按"外部设施类"登记；
 * - `serve` 使用随机空闲端口，绝不占用固定端口（避免与用户正在跑的服务打架）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `scripts/` 下）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** CLI 入口（构建产物）。 */
const CLI = join(ROOT, 'dist', 'src', 'cli', 'exec.js');
/** 报告落盘位置（gitignored 的运行时目录）。 */
const REPORT = join(ROOT, '.omniharness', 'real-run-report.json');
/** 本次要跑的阶段。 */
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=all').slice(8);

/** 逐项结论。 */
const results = [];

/**
 * 找一个空闲端口（绝不占用固定端口）。
 * @returns 可用端口号。
 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/**
 * 从一段文本里抽出第一个可解析的 **JSON 数组**（容忍前后混有告警/日志行）。
 *
 * 为什么要它：① CLI 的 JSON 输出**不带尾换行**，把它与 stderr 合并后 `[]` 会和下一条告警粘成
 * `[](node:123) ExperimentalWarning…`（首版就因此假红）；② 输出里可能混 `[omniharness] …` 告警行。
 * @param text 待解析文本（一般是 **stdout**）。
 * @returns 解析出的数组，或 undefined。
 */
function firstJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 收缩范围继续试 */
    }
  }
  return undefined;
}

/**
 * 从一段文本里抽出第一个可解析的 **JSON 对象**（同 {@link firstJsonArray} 的理由）。
 * @param text 待解析文本（一般是 **stdout**）。
 * @returns 解析出的对象，或 undefined。
 */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* 收缩范围继续试 */
    }
  }
  return undefined;
}

/**
 * 跑一条 CLI 命令并记录结论。
 * @param name 人类可读的用例名。
 * @param argv CLI 参数。
 * @param opts 选项：cwd / env / timeoutMs / expect（返回 true=通过，字符串=失败原因）。
 * @returns 记录对象（额外含 stdout/stderr，便于断言分流的输出）。
 */
function runCli(name, argv, opts = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const out = `${stdout}${stderr}`;
  const expected = opts.expect;
  const verdict =
    expected === undefined ? r.status === 0 : expected(out, r.status, { stdout, stderr });
  const ok = verdict === true;
  const record = {
    name,
    argv,
    exit: r.status,
    ms: Date.now() - started,
    ok,
    note: ok ? (typeof opts.note === 'string' ? opts.note : '') : String(verdict),
    evidence: out.trim().split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300),
  };
  results.push(record);
  console.log(`[${ok ? '✓' : '✗'}] ${name}（exit=${String(r.status)}，${String(record.ms)}ms）`);
  if (!ok) console.log(`    ↳ ${String(verdict)}`);
  return { ...record, out, stdout, stderr, status: r.status };
}

/** 造临时工作区（自带配置/资产包/事件目录）。 */
function makeWorkspace() {
  const ws = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? '/tmp', 'omni-realrun-'));
  writeFileSync(
    join(ws, 'omniharness.json'),
    `${JSON.stringify(
      {
        modelAdapter: 'mock',
        approval: 'rules',
        capability: { enabled: true },
        evolutionRlvr: { enabled: true, kernel: false },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  mkdirSync(join(ws, '.omniharness'), { recursive: true });
  // 给单跑回路一点"语料"，让检索/上下文路径不是空跑。
  writeFileSync(
    join(ws, 'notes.md'),
    '# 演示工作区\n\n本文件用于真实跑测：检索与上下文装配需要一点真实文本。\nOMNI_REAL_RUN_MARKER\n',
    'utf8',
  );
  return ws;
}

/** 阶段 1：CLI 基础 + 单跑回路 + 治理/身份/KV/编排。 */
function phaseCore(ws) {
  // ---- 基础入口 ----
  runCli('--version', ['--version'], { expect: (o) => /omniharness \d/.test(o) || '无版本输出' });
  runCli('--help（按设计 exit 2）', ['--help'], {
    expect: (_o, s) => s === 2 || `期望 exit 2，实际 ${String(s)}`,
  });
  runCli('doctor（带配置 ⇒ 应 exit 0）', ['doctor'], {
    cwd: ws,
    expect: (o, s) =>
      (s === 0 && /诊断报告/.test(o)) || `exit=${String(s)}（报告缺"诊断报告"或有问题项）`,
  });
  runCli('--dump-config', ['--dump-config', '--prompt', 'x'], {
    cwd: ws,
    expect: (o) => (/"modelAdapter"/.test(o) && /"capability"/.test(o)) || 'dump 缺关键键',
  });
  runCli('native info（原生内核）', ['native', 'info'], {
    cwd: ws,
    expect: (o) =>
      (/"available":(true|false)/.test(o) && /"modulePath"|"reason"/.test(o)) || '原生信息形状不符',
  });

  // ---- 单跑回路 ----
  const text = runCli(
    '单跑（mock，headless）',
    ['-p', '--prompt', '你好', '--model-adapter', 'mock'],
    {
      cwd: ws,
      expect: (o) => (o.trim().length > 0 && !/执行失败/.test(o)) || '无最终文本或执行失败',
    },
  );
  const json = runCli(
    '单跑 --output-format json',
    ['-p', '--prompt', 'hi', '--model-adapter', 'mock', '--output-format', 'json'],
    {
      cwd: ws,
      expect: (_o, _s, ctx) => {
        const parsed = firstJsonObject(ctx.stdout);
        if (parsed === undefined) return `stdout 里没有 JSON 对象：${ctx.stdout.slice(0, 120)}`;
        return parsed.ok === true && typeof parsed.sessionId === 'string'
          ? true
          : 'JSON 里 ok/sessionId 不符';
      },
    },
  );
  const sessionId = (() => {
    const parsed = firstJsonObject(json.stdout);
    return parsed === undefined ? '' : String(parsed.sessionId ?? '');
  })();
  const eventsFile = join(ws, 'events.jsonl');
  runCli(
    '单跑 --output 事件落盘',
    ['-p', '--prompt', 'hi', '--model-adapter', 'mock', '--output', eventsFile],
    {
      cwd: ws,
      expect: () => {
        if (!existsSync(eventsFile)) return '事件文件未生成';
        const lines = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
        if (lines.length === 0) return '事件文件为空';
        try {
          const first = JSON.parse(lines[0]);
          return typeof first.type === 'string' ? true : '首条事件缺 type';
        } catch (error) {
          return `事件非 JSONL：${String(error)}`;
        }
      },
    },
  );
  if (sessionId !== '') {
    runCli(
      'resume（续跑同一会话）',
      ['-p', '--prompt', '继续', '--model-adapter', 'mock', '--resume', sessionId],
      {
        cwd: ws,
        expect: (o) => (o.trim().length > 0 && !/执行失败/.test(o)) || '续跑失败',
      },
    );
    runCli(
      'trace read（默认目录真写-真读往返）',
      ['trace', 'read', '--session', sessionId, '--json'],
      {
        cwd: ws,
        expect: (o, s) => {
          if (s !== 0)
            return `exit=${String(s)}（默认目录下应能读到刚写入的会话）：${o.slice(0, 200)}`;
          return o.includes(sessionId) ? true : '输出里没有该会话 id';
        },
      },
    );
  } else {
    results.push({ name: 'resume / trace read', ok: false, note: '缺 sessionId（上一步未拿到）' });
  }

  // ---- 治理 / 资产 / 审计 / 许可 ----
  runCli('capability list --json（配置已开）', ['capability', 'list', '--json'], {
    cwd: ws,
    expect: (o) => /skill|workflow-template|\[/.test(o) || '未列出已注册类型',
  });
  runCli('evolution status（台账验签）', ['evolution', 'status'], {
    cwd: ws,
    expect: (o) => /台账|验签|ok/.test(o) || '台账状态输出不符',
  });
  runCli('license status（无 license ⇒ 用法码 2）', ['license', 'status'], {
    cwd: ws,
    expect: (_o, s) => s === 2 || `期望用法码 2，实际 ${String(s)}`,
  });
  const auditDir = join(ws, 'audit');
  // 审计 sink **只在 serve/server 装配**（第五十九轮实测）：单跑路径上 `--audit-dir` 必须 fail-closed，
  // 而不是"接受却不写"（那会让用户以为有审计链）。真正的审计链端到端在 serve 阶段验。
  runCli(
    '单跑 + --audit-dir ⇒ fail-closed（审计只在 serve）',
    ['-p', '--prompt', '审计一次', '--model-adapter', 'mock', '--audit-dir', auditDir],
    {
      cwd: ws,
      expect: (o, s) =>
        (s !== 0 && /审计/.test(o)) || `期望非零退出且点明审计，实际 exit=${String(s)}`,
    },
  );
  runCli(
    'audit export（空目录 ⇒ 合法空数组）',
    ['audit', 'export', '--audit-dir', auditDir, '--format', 'json'],
    {
      cwd: ws,
      expect: (_o, _s, ctx) => {
        const parsed = firstJsonArray(ctx.stdout);
        return parsed !== undefined ? true : `stdout 里没有 JSON 数组：${ctx.stdout.slice(0, 120)}`;
      },
    },
  );
  runCli('profile list', ['profile', 'list'], {
    cwd: ws,
    expect: (o) => !/执行失败|未知旗标/.test(o) || 'profile list 失败',
  });

  // ---- 身份（真实 Ed25519 全链路）----
  const gen = runCli('identity generate', ['identity', 'generate'], {
    cwd: ws,
    expect: (o) => /privateKeyPkcs8Base64/.test(o) || '未产出密钥材料',
  });
  const key = (() => {
    try {
      return JSON.parse(gen.out.trim().split('\n')[0]).privateKeyPkcs8Base64 ?? '';
    } catch {
      return '';
    }
  })();
  if (key !== '') {
    const signed = runCli(
      'identity sign',
      ['identity', 'sign', '--private-key', key, '--payload', 'hello-real-run'],
      {
        cwd: ws,
        expect: (o) => /signature/.test(o) || '未产出签名',
      },
    );
    const sig = (() => {
      try {
        return JSON.parse(signed.out.trim().split('\n')[0]).signature ?? '';
      } catch {
        return '';
      }
    })();
    runCli(
      'identity verify（真验签）',
      [
        'identity',
        'verify',
        '--private-key',
        key,
        '--payload',
        'hello-real-run',
        '--signature',
        sig,
      ],
      {
        cwd: ws,
        expect: (o) => /true/.test(o) || '验签未通过',
      },
    );
  } else {
    results.push({ name: 'identity sign/verify', ok: false, note: '上一步未拿到私钥' });
  }

  // ---- KV ----
  const kvFile = join(ws, 'kv.json');
  runCli('kv set', ['kv', 'set', '--key', 'k1', '--value', 'v1', '--kv-file', kvFile], {
    cwd: ws,
    expect: (o) => !/执行失败|未知旗标/.test(o) || 'kv set 失败',
  });
  runCli('kv get（读回同值）', ['kv', 'get', '--key', 'k1', '--kv-file', kvFile], {
    cwd: ws,
    expect: (o) => /v1/.test(o) || '未读回写入的值',
  });
  runCli('kv list', ['kv', 'list', '--kv-file', kvFile], {
    cwd: ws,
    expect: (o) => /k1/.test(o) || '列表里没有刚写的键',
  });

  // ---- 编排 ----
  const workflowFile = join(ws, 'wf.json');
  writeFileSync(
    workflowFile,
    `${JSON.stringify(
      {
        steps: [
          { id: 'a', prompt: '第一步：写一句问候', tools: [] },
          { id: 'b', prompt: '第二步：复述上一步结论', dependsOn: ['a'], tools: [] },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  runCli(
    'workflow --file（两步编排）',
    ['workflow', '--file', workflowFile, '--model-adapter', 'mock'],
    {
      cwd: ws,
      timeoutMs: 180000,
      expect: (o) => !/执行失败|用法:/.test(o) || 'workflow 未跑通',
    },
  );
  runCli(
    'goal（单轮目标回路）',
    ['goal', '把 README 的错别字修掉', '--goal-max-iterations', '1', '--model-adapter', 'mock'],
    {
      cwd: ws,
      timeoutMs: 180000,
      expect: (o) => !/用法:|执行失败/.test(o) || 'goal 未跑通',
    },
  );
  runCli(
    'compare（A/B 同为 mock）',
    ['compare', '--prompt', 'hi', '--adapter-a', 'mock', '--adapter-b', 'mock'],
    {
      cwd: ws,
      expect: (o) => /对比|模型 A/.test(o) || '未见对比输出',
    },
  );
}

/** 阶段 2：真实第三方 MCP stdio 链路（自建 fixture 服务端）。 */
function phaseMcp(ws) {
  const fixture = join(ROOT, '.omniharness', 'real-run-mcp-server.mjs');
  mkdirSync(dirname(fixture), { recursive: true });
  writeFileSync(fixture, MCP_FIXTURE, 'utf8');
  const spec = `demo=node ${fixture}`;
  runCli('mcp list（真实 stdio 对端）', ['mcp', 'list', '--server', spec], {
    cwd: ws,
    timeoutMs: 90000,
    expect: (o) => /echo/.test(o) || `未列出 fixture 的 echo 工具：${o.slice(0, 200)}`,
  });
  runCli(
    'mcp call（真实工具调用）',
    ['mcp', 'call', '--server', spec, '--tool', 'echo', '--args', '{"text":"real-run"}'],
    {
      cwd: ws,
      timeoutMs: 90000,
      expect: (o) => /echo: real-run/.test(o) || `未见对端回执：${o.slice(0, 200)}`,
    },
  );
}

/** 阶段 3：web 构建 + serve 的 HTTP / WS / 静态页。 */
async function phaseServe(ws) {
  // 前端产物：必须存在且是**本次构建**的（否则"UI 能开"是旧产物在骗人）。
  const webBuild = spawnSync('npm', ['run', 'web:build'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  results.push({
    name: 'web:build（前端产物）',
    argv: ['npm', 'run', 'web:build'],
    exit: webBuild.status,
    ok: webBuild.status === 0,
    note: webBuild.status === 0 ? '' : '前端构建失败',
    evidence: `${webBuild.stdout ?? ''}${webBuild.stderr ?? ''}`
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ⏎ ')
      .slice(0, 300),
  });
  console.log(`[${webBuild.status === 0 ? '✓' : '✗'}] web:build（前端产物）`);

  const port = await freePort();
  const auditDir = join(ws, 'audit-serve');
  const child = spawn(
    process.execPath,
    // 显式 `--workspace ws`：否则本机固定项目（用户级配置）会接手工作区（见 realUiScenario 同处注释）。
    [CLI, 'serve', '--port', String(port), '--workspace', ws, '--audit-dir', auditDir],
    {
      cwd: ws,
      env: { ...process.env, OMNI_SEMANTIC_RECALL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += String(d)));
  child.stderr.on('data', (d) => (serverOut += String(d)));
  const base = `http://127.0.0.1:${String(port)}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    return { status: res.status, text };
  };
  const record = (name, ok, note, evidence) => {
    results.push({ name, ok, note: ok ? '' : note, evidence: String(evidence).slice(0, 300) });
    console.log(`[${ok ? '✓' : '✗'}] ${name}`);
    if (!ok) console.log(`    ↳ ${note}`);
  };

  try {
    // 就绪轮询（最多 30s）
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`${base}/readyz`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        /* 未起来：继续等 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    record(
      'serve /readyz（就绪探针）',
      ready,
      `30s 内未就绪；服务端输出：${serverOut.slice(-300)}`,
      ready ? 'ok' : '',
    );
    if (!ready) return;

    const health = await get('/healthz');
    record(
      'serve /healthz',
      health.status === 200,
      `HTTP ${String(health.status)}`,
      health.text.slice(0, 120),
    );
    const metrics = await get('/metrics');
    record(
      'serve /metrics',
      metrics.status === 200 && metrics.text.length > 0,
      `HTTP ${String(metrics.status)}`,
      metrics.text.slice(0, 120),
    );
    const page = await get('/');
    record(
      'serve 静态页（Web UI）',
      page.status === 200 && /<script|<div/i.test(page.text),
      `HTTP ${String(page.status)}（页面形状不符：可能未构建 web/dist）`,
      page.text.slice(0, 160),
    );

    // HTTP JSON-RPC（POST /rpc）
    let rpcOk = false;
    let rpcEvidence = '';
    try {
      const res = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'config.get', params: {} }),
      });
      const text = await res.text();
      rpcEvidence = `HTTP ${String(res.status)} ${text.slice(0, 160)}`;
      rpcOk = res.status === 200 && /"jsonrpc"|"result"|"error"/.test(text);
    } catch (error) {
      rpcEvidence = String(error);
    }
    record('serve HTTP /rpc（JSON-RPC）', rpcOk, ' 未拿到 JSON-RPC 响应', rpcEvidence);

    // 真实 WebSocket 往返：用**本仓自己的 CLI**（sdk call）作为客户端
    runCli(
      'serve WS：sdk call --method model.catalog',
      ['sdk', 'call', '--url', `ws://127.0.0.1:${String(port)}/ws`, '--method', 'model.catalog'],
      {
        cwd: ws,
        timeoutMs: 60000,
        expect: (o) => !/调用失败|未知旗标|用法:/.test(o) || `sdk call 失败：${o.slice(0, 200)}`,
      },
    );

    // 审计链端到端（**只在 serve 装配**）：真跑一个回合 ⇒ 审计条目必须落链 ⇒ 读回非空。
    runCli(
      'serve WS：sdk call --method turns.run（真跑一个回合）',
      [
        'sdk',
        'call',
        '--url',
        `ws://127.0.0.1:${String(port)}/ws`,
        '--method',
        'turns.run',
        '--params',
        '{"prompt":"真实跑测：跑一个回合以便产生审计条目"}',
      ],
      {
        cwd: ws,
        timeoutMs: 120000,
        expect: (o) => !/调用失败|未知旗标|用法:/.test(o) || `turns.run 失败：${o.slice(0, 200)}`,
      },
    );
    runCli(
      'audit export（serve 产出的审计链 ⇒ 必须非空）',
      ['audit', 'export', '--audit-dir', auditDir, '--format', 'json'],
      {
        cwd: ws,
        timeoutMs: 60000,
        expect: (_o, _s, ctx) => {
          const parsed = firstJsonArray(ctx.stdout);
          if (parsed === undefined) return `stdout 里没有 JSON 数组：${ctx.stdout.slice(0, 120)}`;
          return parsed.length > 0 ? true : '审计链为空（serve 跑了回合却没落审计条目）';
        },
      },
    );
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** fixture：一个最小但**真的说话**的 MCP stdio 服务端（用官方 SDK）。 */
const MCP_FIXTURE = `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'omni-real-run-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显 text 参数（真实跑测用）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: 'echo: ' + String(req.params.arguments?.text ?? '') }],
}));
await server.connect(new StdioServerTransport());
`;

const ws = makeWorkspace();
// 会话落盘位置：**用一个旋钮把写入方与所有读取方一起**指到临时工作区（`SessionStorageLocation` 的
// 单一事实源语义）。这样既验证了"默认写 + 默认读"的往返，又不往用户真实 `~/.omniharness/sessions` 里写东西。
process.env.OMNI_SESSIONS_DIR = join(ws, 'sessions');
console.log(`真实跑测：阶段=${PHASE} ｜ 临时工作区=${ws}`);
try {
  if (PHASE === 'core' || PHASE === 'all') phaseCore(ws);
  if (PHASE === 'mcp' || PHASE === 'all') phaseMcp(ws);
  if (PHASE === 'serve' || PHASE === 'all') await phaseServe(ws);
} finally {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    `${JSON.stringify({ phase: PHASE, workspace: ws, at: new Date().toISOString(), passed, total: results.length, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n合计：${String(passed)}/${String(results.length)} 通过；报告 → ${REPORT}`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}：${f.note}`);
  }
  if (process.env.OMNI_REALRUN_KEEP !== '1') rmSync(ws, { recursive: true, force: true });
  process.exitCode = failed.length > 0 ? 1 : 0;
}
