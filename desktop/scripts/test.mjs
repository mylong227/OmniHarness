/** 桌面端纯逻辑测试：args / ready 契约 / 环境清洗（不启动 Electron GUI）。 */
import { buildSync } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const out = join(process.cwd(), '..', '.tmp', 'desktop-tests');
mkdirSync(out, { recursive: true });

/** 打包一个纯模块到 CJS 供 Node 测试。 */
function bundle(entry, name, external = []) {
  buildSync({
    absWorkingDir: process.cwd(),
    entryPoints: [entry],
    outfile: join(out, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external,
    logLevel: 'silent',
  });
}

bundle('src/main/lib/args.ts', 'args');
bundle('src/main/lib/ready.ts', 'ready');
bundle('src/main/harnessSupervisor.ts', 'supervisor', ['electron']);
bundle('src/main/desktopState.ts', 'desktopState');

const { parseLaunchArgs } = await import(pathToFileURL(join(out, 'args.cjs')).href);
const { parseReadyInfo } = await import(pathToFileURL(join(out, 'ready.cjs')).href);
const { buildHarnessEnv } = await import(pathToFileURL(join(out, 'supervisor.cjs')).href);
const { DesktopStateStore } = await import(pathToFileURL(join(out, 'desktopState.cjs')).href);

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
