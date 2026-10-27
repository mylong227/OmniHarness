/** 桌面端纯逻辑测试：args / ready 契约 / 环境清洗 / 配置合并（不启动 Electron GUI）。 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const out = join(process.cwd(), '..', '.tmp', 'desktop-tests');
mkdirSync(out, { recursive: true });

/**
 * esbuild 原生二进制路径。
 *
 * 不用 `esbuild` JS API：它会 spawn 一个常驻 service 子进程；本机受限执行环境禁止带管道的
 * 子进程（spawn EPERM）。直接调平台二进制可执行文件（stdio inherit）在本机/CI 都能跑。
 */
const esbuildBin =
  process.env['ESBUILD_BINARY_PATH'] ??
  join(
    process.cwd(),
    'node_modules',
    `@esbuild/${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
  );

/** 打包一个纯模块到 CJS 供 Node 测试。 */
function bundle(entry, name, external = []) {
  const args = [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${join(out, `${name}.cjs`)}`,
    ...external.map((item) => `--external:${item}`),
    '--log-level=error',
  ];
  const result = spawnSync(esbuildBin, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`esbuild 失败（${name}）：${String(result.error?.message ?? result.status)}`);
  }
}

bundle('src/main/lib/args.ts', 'args');
bundle('src/main/lib/ready.ts', 'ready');
bundle('src/main/harnessSupervisor.ts', 'supervisor', ['electron']);
bundle('src/main/desktopState.ts', 'desktopState');
bundle('src/main/config.ts', 'config');
bundle('src/main/i18n/DesktopI18n.ts', 'i18n');
bundle('src/main/app/StartupMarker.ts', 'startup');
bundle('src/main/app/DeepLinkRouter.ts', 'deepLinks');
bundle('src/main/app/HarnessRestartPolicy.ts', 'restartPolicy');
bundle('src/main/app/WindowLifecycle.ts', 'windowLifecycle');
bundle('src/main/app/SmokeHarness.ts', 'smokeHarness');

const { parseLaunchArgs } = await import(pathToFileURL(join(out, 'args.cjs')).href);
const { parseReadyInfo } = await import(pathToFileURL(join(out, 'ready.cjs')).href);
const { buildHarnessEnv } = await import(pathToFileURL(join(out, 'supervisor.cjs')).href);
const { DesktopStateStore } = await import(pathToFileURL(join(out, 'desktopState.cjs')).href);
const { DEFAULT_DESKTOP_CONFIG, loadDesktopConfig, formatCsp } = await import(
  pathToFileURL(join(out, 'config.cjs')).href
);
const { DesktopI18n } = await import(pathToFileURL(join(out, 'i18n.cjs')).href);
const { StartupMarker } = await import(pathToFileURL(join(out, 'startup.cjs')).href);
const { DeepLinkRouter } = await import(pathToFileURL(join(out, 'deepLinks.cjs')).href);
const { HarnessRestartPolicy } = await import(pathToFileURL(join(out, 'restartPolicy.cjs')).href);
const { WindowLifecycle } = await import(pathToFileURL(join(out, 'windowLifecycle.cjs')).href);
const { SmokeHarness } = await import(pathToFileURL(join(out, 'smokeHarness.cjs')).href);

test('DesktopI18n：system 解析 + 中英词条完整 + 占位符替换', () => {
  assert.equal(DesktopI18n.resolve('system', 'en-US'), 'en-US');
  assert.equal(DesktopI18n.resolve('system', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(DesktopI18n.resolve('en-US', 'zh-CN'), 'en-US');
  assert.equal(DesktopI18n.resolve(undefined, 'en-GB'), 'en-US');
  const zh = new DesktopI18n('zh-CN');
  const en = new DesktopI18n('en-US');
  assert.equal(zh.t('menu.file'), '文件');
  assert.equal(en.t('menu.file'), 'File');
  assert.equal(
    en.t('dialog.updateAvailableMessage', { version: '0.2.1' }),
    'OmniHarness 0.2.1 is available',
  );
  assert.equal(DEFAULT_DESKTOP_CONFIG.app.language, 'system');
  assert.equal(DEFAULT_DESKTOP_CONFIG.update.channel, 'latest');
  assert.equal(DEFAULT_DESKTOP_CONFIG.update.allowDowngrade, false);
  assert.equal(DEFAULT_DESKTOP_CONFIG.window.showShortcut, 'CommandOrControl+Shift+O');
});

test('DesktopI18n：中英语言包键集合完全一致', () => {
  const zh = new DesktopI18n('zh-CN');
  const en = new DesktopI18n('en-US');
  for (const key of [
    'menu.file',
    'menu.help',
    'tray.show',
    'tray.quit',
    'dialog.startFailedTitle',
    'dialog.crashTitle',
    'dialog.updateLatestMessage',
    'window.starting',
  ]) {
    assert.notEqual(zh.t(key), key, `zh 缺少 ${key}`);
    assert.notEqual(en.t(key), key, `en 缺少 ${key}`);
  }
});

test('StartupMarker：固定阶段格式（供 startupReport 解析）', () => {
  const lines = [];
  const marker = new StartupMarker({ write: (_kind, text) => lines.push(text) });
  marker.mark('config.loaded');
  marker.mark('window.created');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /^startup\.phase phase=[a-z.]+ elapsedMs=\d+$/u);
  }
});

test('DeepLinkRouter：协议/workspace 解析 + 就绪前排队', async () => {
  assert.equal(
    DeepLinkRouter.workspaceOf('omniharness://open?workspace=D%3A%5Cws', 'omniharness'),
    'D:\\ws',
  );
  assert.equal(DeepLinkRouter.workspaceOf('https://example.com/?workspace=x', 'omniharness'), null);
  assert.equal(DeepLinkRouter.workspaceOf('not a url', 'omniharness'), null);
  let switched = '';
  const router = new DeepLinkRouter({
    protocol: 'omniharness',
    uiReadyTimeoutMs: 10,
    getWindow: () => null,
    isReady: () => false,
    switchWorkspace: async (path) => {
      switched = path;
    },
  });
  await router.handle('omniharness://open?workspace=D%3A%5Cws');
  assert.equal(switched, '', '未就绪时不得切工作区');
  router.flush();
});

test('HarnessRestartPolicy：窗口内限次，超窗恢复', () => {
  const policy = new HarnessRestartPolicy(2, 1000);
  assert.equal(policy.allow(10_000), true);
  assert.equal(policy.allow(10_100), true);
  assert.equal(policy.allow(10_200), false, '窗口内第三次必须拒绝');
  assert.equal(policy.allow(11_500), true, '超出窗口后重新允许');
  policy.reset();
  assert.equal(policy.allow(12_000), true);
  assert.equal(DEFAULT_DESKTOP_CONFIG.harness.autoRestart, true);
  assert.ok(DEFAULT_DESKTOP_CONFIG.harness.restartMax >= 1);
});

test('WindowLifecycle：重建窗口/加载 UI/关闭到托盘', () => {
  const calls = { created: 0, loaded: 0, shown: 0, hidden: 0, tray: 0, menu: 0 };
  let window = null;
  let closeHandler = null;
  const state = {
    closeToTray: true,
    openAtLogin: false,
    get: () => ({ closeToTray: state.closeToTray, openAtLogin: state.openAtLogin }),
    setCloseToTray: (value) => {
      state.closeToTray = value;
    },
    setOpenAtLogin: (value) => {
      state.openAtLogin = value;
    },
  };
  const tray = { refresh: () => (calls.tray += 1) };
  const lifecycle = new WindowLifecycle({
    current: () => ({ window, handle: {}, state, tray }),
    createWindow: () => {
      calls.created += 1;
      window = {
        isMinimized: () => false,
        restore: () => undefined,
        show: () => (calls.shown += 1),
        focus: () => undefined,
        hide: () => (calls.hidden += 1),
        on: (event, handler) => {
          if (event === 'close') closeHandler = handler;
        },
        webContents: { on: () => undefined },
      };
      return window;
    },
    setWindow: () => undefined,
    loadHarness: () => (calls.loaded += 1),
    refreshMenu: () => (calls.menu += 1),
    isQuitting: () => false,
    applyAutoStart: () => undefined,
    logger: () => null,
  });
  lifecycle.show();
  assert.equal(calls.created, 1);
  assert.equal(calls.loaded, 1);
  assert.equal(calls.shown, 1);
  closeHandler({ preventDefault: () => undefined });
  assert.equal(calls.hidden, 1, '关闭到托盘应隐藏窗口');
  lifecycle.setCloseToTray(false);
  assert.equal(state.closeToTray, false);
  assert.equal(calls.tray, 1);
  assert.equal(calls.menu, 1);
  lifecycle.setOpenAtLogin(true);
  assert.equal(state.openAtLogin, true);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('WindowLifecycle：渲染层自愈——加载失败/渲染崩溃自动重载，耗尽后交人机出口', async () => {
  const calls = { loaded: 0, uiGone: 0 };
  const handlers = {};
  let window = null;
  const state = {
    closeToTray: true,
    openAtLogin: false,
    get: () => ({ closeToTray: state.closeToTray, openAtLogin: state.openAtLogin }),
    setCloseToTray: () => undefined,
    setOpenAtLogin: () => undefined,
  };
  const lifecycle = new WindowLifecycle({
    current: () => ({ window, handle: {}, state, tray: null }),
    createWindow: () => {
      window = {
        isMinimized: () => false,
        restore: () => undefined,
        show: () => undefined,
        focus: () => undefined,
        hide: () => undefined,
        isDestroyed: () => false,
        on: () => undefined,
        webContents: {
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
      };
      return window;
    },
    setWindow: () => undefined,
    loadHarness: () => (calls.loaded += 1),
    refreshMenu: () => undefined,
    isQuitting: () => false,
    applyAutoStart: () => undefined,
    logger: () => ({ write: () => undefined }),
    recovery: { maxAttempts: 2, windowMs: 60_000, delayMs: 5 },
    onUiGone: async () => {
      calls.uiGone += 1;
      return 1;
    },
  });
  lifecycle.show();
  assert.equal(calls.loaded, 1, '首次加载不受自愈影响');
  assert.ok(handlers['did-fail-load'], '必须绑定 did-fail-load');
  assert.ok(handlers['render-process-gone'], '必须绑定 render-process-gone');

  // ① 前两次主帧加载失败：各自延迟后用当前句柄重载。
  await handlers['did-fail-load'](null, -2, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', true);
  await sleep(40);
  assert.equal(calls.loaded, 2, '第一次失败后应自动重载');
  await handlers['did-fail-load'](null, -2, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', true);
  await sleep(40);
  assert.equal(calls.loaded, 3, '第二次失败后仍自动重载');

  // ② 第三次：窗口内达到上限 → 人机出口；选重试 ⇒ 清零计数再载一次。
  await handlers['did-fail-load'](null, -2, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', true);
  await sleep(60);
  assert.equal(calls.uiGone, 1, '恢复耗尽必须交人机出口');
  assert.equal(calls.loaded, 4, '用户选重试后应再载一次');

  // ③ 过滤面：-3（新加载取代旧加载）与子帧失败都不恢复。
  await handlers['did-fail-load'](null, -3, 'ERR_ABORTED', 'http://127.0.0.1:1/', true);
  await handlers['did-fail-load'](null, -2, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', false);
  await sleep(30);
  assert.equal(calls.loaded, 4, '正常取消/子帧失败不得触发恢复');

  // ④ 渲染进程崩溃（abnormal-exit / oom）恢复；killed（外部干预）不恢复。
  await handlers['render-process-gone'](null, { reason: 'abnormal-exit', exitCode: 1 });
  await sleep(40);
  assert.equal(calls.loaded, 5, '渲染崩溃后应自动重载');
  await handlers['render-process-gone'](null, { reason: 'oom', exitCode: 0 });
  await sleep(40);
  assert.equal(calls.loaded, 6, 'oom 也应自动重载');
  await handlers['render-process-gone'](null, { reason: 'killed', exitCode: 1 });
  await sleep(30);
  assert.equal(calls.loaded, 6, 'killed 不触发恢复');
});

test('WindowLifecycle：recovery 未配置时保持旧行为（只记日志不恢复）', async () => {
  const calls = { loaded: 0 };
  const handlers = {};
  let window = null;
  const state = {
    closeToTray: true,
    openAtLogin: false,
    get: () => ({ closeToTray: state.closeToTray, openAtLogin: state.openAtLogin }),
    setCloseToTray: () => undefined,
    setOpenAtLogin: () => undefined,
  };
  const lifecycle = new WindowLifecycle({
    current: () => ({ window, handle: {}, state, tray: null }),
    createWindow: () => {
      window = {
        isMinimized: () => false,
        restore: () => undefined,
        show: () => undefined,
        focus: () => undefined,
        hide: () => undefined,
        on: () => undefined,
        webContents: { on: (event, handler) => (handlers[event] = handler) },
      };
      return window;
    },
    setWindow: () => undefined,
    loadHarness: () => (calls.loaded += 1),
    refreshMenu: () => undefined,
    isQuitting: () => false,
    applyAutoStart: () => undefined,
    logger: () => ({ write: () => undefined }),
  });
  lifecycle.show();
  await handlers['did-fail-load'](null, -2, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', true);
  await sleep(30);
  assert.equal(calls.loaded, 1, '未配置 recovery 时不得自动重载（行为不变）');
});

/** 冒烟判定入参基线：全绿事实（各用例按需覆盖）。 */
function smokeFacts(overrides = {}) {
  return {
    windowAlive: true,
    windowVisible: true,
    hiddenLaunch: false,
    harnessState: 'running',
    harnessEndpoint: '127.0.0.1:51234',
    loadedUrl: 'http://127.0.0.1:51234/?token=x',
    dom: { root: true, bridgeVersion: 3 },
    trayCreated: true,
    notificationsSupported: true,
    protocolRegistered: false,
    ...overrides,
  };
}

test('SmokeHarness：全绿事实 ⇒ pass，含 5 致命 + 3 观测', () => {
  const report = SmokeHarness.judge(smokeFacts());
  assert.equal(report.pass, true);
  assert.equal(report.checks.length, 8);
  for (const name of [
    'window.created',
    'window.visible',
    'harness.ready',
    'ui.origin',
    'ui.mounted',
  ]) {
    assert.ok(
      report.checks.some((c) => c.name === name && c.ok),
      `致命项 ${name} 应通过`,
    );
  }
  for (const name of ['tray', 'notifications', 'protocol']) {
    assert.ok(
      report.checks.some((c) => c.name === name),
      `观测项 ${name} 应在报告里`,
    );
  }
});

test('SmokeHarness：五类致命断言各自能判死', () => {
  const cases = [
    ['window.created', smokeFacts({ windowAlive: false })],
    ['window.visible', smokeFacts({ windowVisible: false })],
    ['harness.ready', smokeFacts({ harnessState: 'crashed', harnessEndpoint: null })],
    ['ui.origin', smokeFacts({ loadedUrl: 'data:text/html,...' })],
    ['ui.mounted', smokeFacts({ dom: null })],
  ];
  for (const [name, facts] of cases) {
    const report = SmokeHarness.judge(facts);
    assert.equal(report.pass, false, `${name} 失败必须判死`);
    const check = report.checks.find((c) => c.name === name);
    assert.equal(check?.ok, false, `${name} 应带失败明细：${check?.detail}`);
  }
});

test('SmokeHarness：--hidden 启动时按「预期隐藏」判定可见性；观测项不判死', () => {
  assert.equal(
    SmokeHarness.judge(smokeFacts({ hiddenLaunch: true, windowVisible: false })).pass,
    true,
  );
  const degraded = SmokeHarness.judge(
    smokeFacts({ trayCreated: false, notificationsSupported: false, protocolRegistered: false }),
  );
  assert.equal(degraded.pass, true, '托盘/通知/协议缺失是观测项，不得判死');
});

test('SmokeHarness：DOM 探针脚本可执行且含桥版本判定', () => {
  // 纯 jsdom 级执行：探针在缺 window.omni 时必须报 bridgeVersion=0（而不是抛错）。
  const root = { querySelector: () => null };
  const fakeWindow = { document: root };
  const probe = SmokeHarness.DOM_PROBE;
  assert.ok(probe.includes('apiVersion'), '探针必须检查桥版本');
  const fn = new Function('window', `return ${probe};`);
  assert.deepEqual(fn(fakeWindow), { root: false, bridgeVersion: 0 });
});

test('parseLaunchArgs: workspace / inline / hidden / deep link', () => {
  assert.deepEqual(parseLaunchArgs(['electron', '.', '--workspace', 'D:\\ws']), {
    workspace: 'D:\\ws',
    hidden: false,
    deepLink: null,
  });
  assert.deepEqual(parseLaunchArgs(['electron', '.', '--workspace=D:\\ws', '--hidden']), {
    workspace: 'D:\\ws',
    hidden: true,
    deepLink: null,
  });
  assert.equal(
    parseLaunchArgs(['electron', '.', 'omniharness://open?workspace=x']).deepLink,
    'omniharness://open?workspace=x',
  );
});

test('parseReadyInfo: valid + invalid payloads', () => {
  const valid = {
    protocol: 1,
    pid: 42,
    host: '127.0.0.1',
    port: 51234,
    workspace: 'D:\\ws',
    apiVersion: '0.1.0',
    harnessVersion: '0.2.0',
    startedAt: '2026-10-24T00:00:00.000Z',
  };
  assert.equal(parseReadyInfo(valid)?.port, 51234);
  assert.equal(parseReadyInfo({ ...valid, protocol: 2 }), null);
  assert.equal(parseReadyInfo({ ...valid, port: 0 }), null);
  assert.equal(parseReadyInfo({ ...valid, pid: -1 }), null);
  assert.equal(parseReadyInfo(null), null);
});

test('buildHarnessEnv: strips dangerous vars and injects controlled vars', () => {
  const env = buildHarnessEnv(
    {
      NODE_OPTIONS: '--require evil.js',
      NODE_PATH: 'x',
      NODE_EXTRA_CA_CERTS: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:\\Windows',
    },
    { OMNI_SERVE_TOKEN: 't', OMNI_NO_UI_URL: '1' },
  );
  assert.equal(env['NODE_OPTIONS'], undefined);
  assert.equal(env['NODE_PATH'], undefined);
  assert.equal(env['NODE_EXTRA_CA_CERTS'], undefined);
  assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined);
  assert.equal(env['OMNI_SERVE_TOKEN'], 't');
  assert.equal(env['OMNI_NO_UI_URL'], '1');
});

test('品牌图标：PNG 为 512×512，ICO 为多尺寸 Windows 图标', () => {
  const png = readFileSync(join(process.cwd(), 'static', 'icon.png'));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  const ico = readFileSync(join(process.cwd(), 'static', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 7, 'ICO 必须包含多尺寸（16–256）');
});

test('parseLaunchArgs: 深链协议可配置（不再硬编码 omniharness）', () => {
  assert.equal(
    parseLaunchArgs(['electron', '.', 'omni-test://open?workspace=x'], 'omni-test').deepLink,
    'omni-test://open?workspace=x',
  );
  assert.equal(
    parseLaunchArgs(['electron', '.', 'omniharness://open?workspace=x'], 'omni-test').deepLink,
    null,
  );
});

test('desktop.config.json 必须与内置默认值逐字段相等（防配置/代码漂移）', () => {
  const shipped = JSON.parse(readFileSync(join(process.cwd(), 'desktop.config.json'), 'utf8'));
  assert.deepEqual(shipped, DEFAULT_DESKTOP_CONFIG);
  const loaded = loadDesktopConfig({ builtinFile: join(process.cwd(), 'desktop.config.json') });
  assert.deepEqual(loaded.config, DEFAULT_DESKTOP_CONFIG);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.sources.length, 1);
});

test('loadDesktopConfig: 逐字段覆盖 + 非法值夹取/回落 + 未知权限剔除', () => {
  const dir = join(out, 'config');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const userFile = join(dir, 'desktop.config.json');
  writeFileSync(
    userFile,
    JSON.stringify({
      app: { language: 'en-US' },
      window: { width: 100, backgroundThrottling: true },
      harness: { host: '0.0.0.0', readyTimeoutMs: 'soon', tokenBytes: 8 },
      security: { permissions: ['geolocation', 'notifications'] },
      update: { autoDownload: 'yes' },
      unknownSection: { ignored: true },
    }),
    'utf8',
  );
  const loaded = loadDesktopConfig({
    builtinFile: join(process.cwd(), 'desktop.config.json'),
    userFile,
  });
  assert.equal(loaded.config.window.width, 640, 'width 夹到最小值 640');
  assert.equal(loaded.config.window.backgroundThrottling, true);
  assert.equal(loaded.config.harness.host, '127.0.0.1', '非回环主机回落');
  assert.equal(loaded.config.harness.readyTimeoutMs, 30_000, '类型错误回落');
  assert.equal(loaded.config.harness.tokenBytes, 16, 'tokenBytes 夹到最小值 16');
  assert.deepEqual(loaded.config.security.permissions, ['notifications']);
  assert.equal(loaded.config.update.autoDownload, false);
  assert.equal(loaded.config.app.language, 'en-US');
  assert.ok(loaded.warnings.length >= 4, `应收集多条告警，实际 ${loaded.warnings.length}`);
  assert.ok(loaded.warnings.some((line) => line.includes('harness.host')));
});

test('loadDesktopConfig: 非法 app.language 回落 system 并告警', () => {
  const dir = join(out, 'config-lang');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const userFile = join(dir, 'desktop.config.json');
  writeFileSync(userFile, JSON.stringify({ app: { language: 'fr-FR' } }), 'utf8');
  const loaded = loadDesktopConfig({
    builtinFile: join(process.cwd(), 'desktop.config.json'),
    userFile,
  });
  assert.equal(loaded.config.app.language, 'system');
  assert.ok(loaded.warnings.some((line) => line.includes('app.language')));
});

test('loadDesktopConfig: 环境文件优先级最高（DEFAULT < builtin < user < env）', () => {
  const dir = join(out, 'config-env');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const userFile = join(dir, 'user.json');
  const envFile = join(dir, 'env.json');
  writeFileSync(userFile, JSON.stringify({ window: { width: 1000 } }), 'utf8');
  writeFileSync(envFile, JSON.stringify({ window: { width: 1100 } }), 'utf8');
  const loaded = loadDesktopConfig({
    builtinFile: join(process.cwd(), 'desktop.config.json'),
    userFile,
    envFile,
  });
  assert.equal(loaded.config.window.width, 1100);
  assert.equal(loaded.sources.length, 3);
});

test('formatCsp: 指令顺序稳定且含配置项', () => {
  const csp = formatCsp(DEFAULT_DESKTOP_CONFIG.security.csp);
  assert.ok(csp.startsWith("default-src 'none'; script-src 'self' 'unsafe-inline'"));
  assert.ok(csp.includes("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"));
  assert.ok(csp.endsWith("frame-ancestors 'none'"));
});

test('DesktopStateStore: 默认值 + 持久化 + 重新加载', () => {
  const dir = join(out, 'state');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const first = new DesktopStateStore(dir);
  assert.equal(first.get().closeToTray, true);
  assert.equal(first.get().openAtLogin, false);
  assert.deepEqual(first.get().recentWorkspaces, []);
  first.rememberWorkspace('D:\\ws');
  first.setCloseToTray(false);
  first.setOpenAtLogin(true);
  const second = new DesktopStateStore(dir);
  assert.equal(second.get().workspace, 'D:\\ws');
  assert.equal(second.get().closeToTray, false);
  assert.equal(second.get().openAtLogin, true);
  assert.deepEqual(second.get().recentWorkspaces, ['D:\\ws']);
  rmSync(dir, { recursive: true, force: true });
});

test('启动阶段标记：main.ts 覆盖 config → workspace → window → harness → ui', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');
  for (const phase of [
    'config.loaded',
    'workspace.resolved',
    'window.created',
    'harness.start',
    'harness.ready',
    'ui.loading',
    'ui.ready',
  ]) {
    assert.ok(source.includes(`'${phase}'`), `main.ts 缺少 startup.phase ${phase} 标记`);
  }
});

test('打包裁剪：locales 只留中英 + stage 删除死重量（onnxruntime-web/@types/old.node）', () => {
  const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8');
  assert.match(builder, /electronLanguages:\s*\n\s*- en-US\s*\n\s*- zh-CN/u);
  const stage = readFileSync(join(process.cwd(), 'scripts', 'stageHarness.mjs'), 'utf8');
  for (const name of ['onnxruntime-web', '@types']) {
    assert.ok(stage.includes(`'${name}'`), `stage 必须删除 ${name}`);
  }
  assert.ok(stage.includes('.old.node'), 'stage 必须清理旧版原生内核产物');
});
