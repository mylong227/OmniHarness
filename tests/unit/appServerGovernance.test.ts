/**
 * F2 服务端判据（`governance.history` / `governance.rollbackTargets`）。
 *
 * ## 判据要钉死什么
 *
 * 1. **数据与证据同源**：RPC 返回的每行都带**该行自己**的复核结论；篡改台账正文后，
 *    对应行必须 `verified:false` 且带上可读原因（服务端不替 UI 做"整链看起来没问题"的概括）；
 * 2. **坏台账也要能看**：台账目录不可用时返回 `available:false` + 可读原因，
 *    **不抛 RPC 错误**（治理台的用途之一就是"看出问题"，自己先崩是最差选择）；
 * 3. **回滚只给锚点**：`governance.rollbackTargets` 给快照候选，不提供执行回滚的方法；
 * 4. **空台账是合法状态**：尚未产生晋升 ⇒ `available:true` 且 0 行（不是错误）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppServer } from '../../src/server/core/appServer.js';
import { AppServerGovernanceHandlers } from '../../src/server/core/appServerGovernanceHandlers.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { HashChainPromotionLedger } from '../../src/evolution/hashChainPromotionLedger.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { Skill } from '../../src/ports/skill/skill.js';

/** 治理视图的返回形状（只取断言用到的字段）。 */
interface GovernanceResult {
  readonly available: boolean;
  readonly reason?: string;
  /** `governance.rollbackTargets` 的专用形状（只给锚点，不给整份视图）。 */
  readonly targets?: readonly { seq: number; skillCount: number }[];
  readonly view?: {
    readonly rows: readonly { seq: number; verified: boolean; reason?: string }[];
    readonly summary: { total: number; verified: number; firstFailureSeq?: number };
    readonly rollbackTargets: readonly { seq: number; skillCount: number }[];
  };
}

/**
 * 造一条技能。
 * @param name 技能名
 * @returns 技能
 */
function skillOf(name: string): Skill {
  return { name, description: `${name} 描述`, instructions: `${name} 步骤` };
}

/**
 * 造一个带真实台账的工作区，并构造指向它的 AppServer。
 * @param opts 是否预置台账 / 是否把台账目录做成普通文件（模拟不可用）
 * @returns 服务端与台账文件路径
 */
function buildServer(
  opts: { readonly ledger: boolean; readonly blocked?: boolean } = { ledger: true },
): {
  readonly server: AppServer;
  readonly ledgerFile: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'gov-rpc-'));
  const ledgerDir = join(workspace, '.omniharness', 'evolution');
  const ledgerFile = join(ledgerDir, 'ledger.jsonl');
  if (opts.blocked === true) {
    // 制造**真实**失败：把 `ledger.jsonl` 做成目录 ⇒ 台账读取必抛 EISDIR ⇒ 走到 `available:false`。
    // （第一版只是把台账目录换成普通文件，结果构造**照样成功**、判据白测——夹具必须制造真失败。）
    mkdirSync(join(ledgerDir, 'ledger.jsonl'), { recursive: true });
  } else if (opts.ledger) {
    const ledger = new HashChainPromotionLedger({
      dir: ledgerDir,
      now: () => '2026-10-04T00:00:00.000Z',
    });
    ledger.snapshotBefore([skillOf('a'), skillOf('b')]);
    ledger.append({ name: 'c', source: 'twist:a+b' });
  }
  const config = ConfigFactory.build({
    workspaceRoot: workspace,
    maxSteps: 4,
    model: { generate: async () => ({ text: '' }) } as never,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const server = new AppServer({
    config,
    transport: { send: () => {}, onMessage: () => {} },
    modelOverrideEnabled: false,
    // 工作区经 displayConfig['workspace'] 注入——**与生产同一口径**（CliServerCmds.displayConfigOf）；
    // 不注入时服务端回落到 process.cwd()，判据会读到另一个空台账（第一版就是这么错的）。
    displayConfig: { workspace },
  });
  return { server, ledgerFile };
}

/**
 * 直接调服务端已注册的 RPC 处理器（不经传输层：本判据只关心数据面语义）。
 * @param server 服务端
 * @param method 方法名
 * @returns 结果
 */
async function call(server: AppServer, method: string): Promise<GovernanceResult> {
  const handlers = (
    server as unknown as {
      handlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;
    }
  ).handlers;
  const handler = handlers.get(method);
  assert.ok(handler !== undefined, `必须注册 ${method}`);
  return (await handler({})) as GovernanceResult;
}

test('F2 RPC：governance.history 返回逐行复核结论与回滚锚点（数据与证据同源）', async () => {
  const { server } = buildServer();
  const result = await call(server, 'governance.history');
  assert.strictEqual(result.available, true, result.reason);
  const view = result.view;
  assert.ok(view !== undefined);
  assert.strictEqual(view.summary.total, 2);
  assert.strictEqual(view.summary.verified, 2, '未篡改台账必须逐行通过');
  assert.deepStrictEqual(
    view.rows.map((row) => row.verified),
    [true, true],
  );
  assert.deepStrictEqual(view.rollbackTargets, [
    { seq: 1, ts: '2026-10-04T00:00:00.000Z', skillCount: 2 },
  ]);

  const targets = await call(server, 'governance.rollbackTargets');
  assert.strictEqual(targets.available, true);
  // 该方法的形状是 `{ available, targets }`（只给锚点，不给整份视图）——判据第一版误当 `view.rollbackTargets`。
  assert.deepStrictEqual(targets.targets, view.rollbackTargets);
});

test('F2 RPC：篡改台账正文 ⇒ 对应行 verified:false 且带可读原因（不替 UI 概括"看起来没问题"）', async () => {
  const { server, ledgerFile } = buildServer();
  const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n');
  writeFileSync(
    ledgerFile,
    `${lines
      .map((line, index) => {
        if (index !== 1) return line;
        const entry = JSON.parse(line) as { promoted?: { name: string; source: string } };
        return JSON.stringify({ ...entry, promoted: { name: 'c', source: 'twist:forged' } });
      })
      .join('\n')}\n`,
    'utf8',
  );
  const result = await call(server, 'governance.history');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.view?.summary.verified, 1, '恰好一行失败');
  assert.strictEqual(result.view?.summary.firstFailureSeq, 2);
  const failed = result.view?.rows.find((row) => row.seq === 2);
  assert.strictEqual(failed?.verified, false);
  assert.match(String(failed?.reason), /自算哈希与记录不符/);
});

test('F2 RPC：台账不可用 ⇒ available:false + 可读原因（**不抛**给 UI），回滚入口同样如实', async () => {
  const { server } = buildServer({ ledger: false, blocked: true });
  const history = await call(server, 'governance.history');
  assert.strictEqual(history.available, false);
  assert.match(String(history.reason), /晋升台账不可用/);
  const targets = await call(server, 'governance.rollbackTargets');
  assert.strictEqual(
    targets.available,
    false,
    '不可用时不得返回空 targets（空列表会被读成"没有可回滚的快照"）',
  );
  assert.match(String(targets.reason), /晋升台账不可用/);
});

test('F2 RPC：空台账是合法状态（尚未产生晋升 ⇒ 0 行，不是错误）', async () => {
  const { server } = buildServer({ ledger: false });
  const result = await call(server, 'governance.history');
  assert.strictEqual(result.available, true, result.reason);
  assert.strictEqual(result.view?.summary.total, 0);
  assert.deepStrictEqual(result.view?.rollbackTargets, []);
});

test('F2 装配链：治理层确实在 AppServer 的继承链上（不是摆设层）', () => {
  // 直接导入并断言继承关系：漏接这一段 ⇒ RPC 不会被注册，而 UI 只会看到"方法不存在"，
  // 报错点离根因很远（本仓"声明未接线"的经典形态）。
  assert.ok(
    AppServer.prototype instanceof AppServerGovernanceHandlers,
    'AppServer 必须继承 AppServerGovernanceHandlers（否则治理 RPC 根本没注册）',
  );
  assert.strictEqual(
    typeof (AppServerGovernanceHandlers.prototype as unknown as Record<string, unknown>)[
      'registerGovernanceHandlers'
    ],
    'function',
    '治理层必须提供注册方法（装配点唯一）',
  );
});
