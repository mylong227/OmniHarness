/**
 * AppServer 的「凭据保险库」处理器（Web 交付项，2026-10-11）：`vault.list` / `vault.set` / `vault.delete`。
 *
 * ## 为什么单独成层
 *
 * 沿 `AppServerBase → … → AppServerObservabilityHandlers → **本层** → AppServer` 的分层约定。
 * 只读可观测那一层**故意只读**（daemon/doctor/audit/trace），而保险库有写方法 —— 读写混层会让
 * "这一层能不能改状态"变得说不清，故单独成层。
 *
 * ## 三条安全纪律（都写成判据）
 *
 * 1. **不回读**：本层**故意不提供** `vault.get` 一类的读值方法。面板的用途是"管理 agent 用的凭据"
 *    （列出名字、写入、删除），把密文读回浏览器页面没有任何必要用途，只会多一条泄露面。
 *    判据断言处理器表里除这三个方法外没有别的 `vault.*`。
 * 2. **列名不带值**：`vault.list` 只回**名字数组**（`VaultPort.listSecrets` 的契约就是"不泄露值"）。
 *    判据用真实写入的密文做**泄漏检测**：响应序列化后不得包含密文。
 * 3. **未接线如实报错**：三条都回 `{ok:false, reason}`，不装作"保险库是空的"
 *    （与 `doctor.report` / `audit.query` 同批处置同源）。
 *
 * @maturity L1 — 三个 RPC 的语义、不回读、不泄露值、未接线如实报错 判据钉死
 * @maturityEvidence tests/unit/vaultRpc.test.ts
 */
import { AppServerObservabilityHandlers } from './appServerObservabilityHandlers.ts';

/** 凭据保险库处理器层。 */
export class AppServerVaultHandlers extends AppServerObservabilityHandlers {
  /**
   * 注册 `vault.list` / `vault.set` / `vault.delete`。
   *
   * @returns 无返回值。
   */
  protected registerVaultHandlers(): void {
    this.handlers.set('vault.list', async () => {
      const vault = this.options.vault;
      if (vault === undefined) {
        return { ok: false, reason: 'vault 未接线（serve 组合根未注入 vault）' };
      }
      return { ok: true, names: await vault.listSecrets() };
    });
    this.handlers.set('vault.set', async (params) => {
      const vault = this.options.vault;
      if (vault === undefined) {
        return { ok: false, reason: 'vault 未接线（serve 组合根未注入 vault）' };
      }
      const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
      const secret = typeof params['secret'] === 'string' ? params['secret'] : '';
      // fail-closed：名字或值缺失一律拒绝（空名字会写出一个无法按名取用的孤儿条目）。
      if (name === '') {
        return { ok: false, reason: 'vault.set 需要非空 name' };
      }
      if (secret === '') {
        return { ok: false, reason: 'vault.set 需要非空 secret（要删除请用 vault.delete）' };
      }
      await vault.setSecret(name, secret);
      return { ok: true, name };
    });
    this.handlers.set('vault.delete', async (params) => {
      const vault = this.options.vault;
      if (vault === undefined) {
        return { ok: false, reason: 'vault 未接线（serve 组合根未注入 vault）' };
      }
      const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
      if (name === '') {
        return { ok: false, reason: 'vault.delete 需要非空 name' };
      }
      const removed = await vault.deleteSecret(name);
      return { ok: true, name, removed };
    });
  }
}
