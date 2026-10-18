// 浏览器类 web 判据的**强制开关**（与 `tests/helpers/requireEnv.ts` 同口径）。
//
// 为什么 web 侧也要有：`tests/**` 的跳过点已由 `tests/unit/requireSwitches.test.ts` 机械核对
// （每个 skip 必须接 `OMNI_REQUIRE_*` 开关），但 `web/test/**` 此前**不在扫描面内** ⇒
// 浏览器类判据（e2e / e2e-cdp / 窄栏重排）可以静默跳过而没人管，正是"跳过即假绿"。
//
// 语义（与 requireEnv 一致）：
//   · 有能力（浏览器 + 全局 WebSocket）⇒ 返回 null，正常跑；
//   · 缺能力且**未**要求 ⇒ 返回一句可读原因（显式 skip，不伪装通过）；
//   · 缺能力但 `OMNI_REQUIRE_BROWSER=1` ⇒ 返回 null ⇒ 调用方必须自己断言能力存在，缺即**失败**。
//
// CI：web job 已设 `OMNI_REQUIRE_BROWSER=1`（该 job 本身也断言 runner 有浏览器），
// 故 CI 上这些判据**不可能**静默跳过。

/**
 * 综合判定是否应当跳过浏览器类判据。
 *
 * ⚠️ 首版把"未设开关"直接当成跳过，于是**本机明明有 Chrome 也照跳**——判据形同不存在。
 * 故这里必须**同时**看"有没有能力"与"要不要强制"。
 *
 * @param {boolean} browserFound `findBrowser()` 的结果（null 视为 false）
 * @returns {string | null} 需要跳过时返回可读原因；否则 null（继续执行，缺浏览器就会失败）
 */
export function skipReasonFor(browserFound: boolean) {
  const required = process.env.OMNI_REQUIRE_BROWSER === '1';
  const hasWebSocket = typeof globalThis.WebSocket === 'function';
  if (required) {
    // 显式要求：一律不跳过（缺能力由调用方的断言报红）。
    return null;
  }
  if (!hasWebSocket) {
    return 'Node 缺全局 WebSocket（需 Node >= 22）';
  }
  if (!browserFound) {
    return '未找到本机 Chrome/Edge；设 OMNI_CHROME_PATH 指定浏览器可执行文件后重跑';
  }
  return null;
}

/**
 * 是否处于"必须跑"模式（调用方据此决定：失败还是跳过）。
 * @returns 要求必须跑为 true
 */
export function requireBrowser() {
  return process.env.OMNI_REQUIRE_BROWSER === '1';
}
