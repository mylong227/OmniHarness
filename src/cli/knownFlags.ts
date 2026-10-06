/**
 * **子命令 / 装配层自行解析**的旗标登记表（2026-10-06 第五十八轮，72 项）。
 *
 * ## 为什么要有这张表
 *
 * `ArgParser.parseArgs` 现在对**未知的 `-` 开头 token** fail-closed（`throw`）。修复前的行为是
 * 静默 `continue`：拼错的旗标**无声无效**，而且它的取值还会被 `collectPositional` 当成 prompt
 * （`--porad x` ⇒ prompt 变成 `x`）——这是本板反复出现的"拼错 = 没生效"的**共同放大器**。
 *
 * 但有一批旗标**不经过 FLAG_TABLE**，它们由各子命令用 `CliArgReader` 直接读
 * （`serve --port`、`mcp call --server`、`store kv --key`…），或由装配层在 `parseArgs` **之前**
 * 扫描（`--auth-required`）。这些名字必须显式登记，否则新规则会把**正在工作的子命令**一起打掉。
 *
 * 为什么单独一个文件（而不是塞进 `cliFlagTable.ts`）：那份文件加完这张表就越过"上帝类"阈值
 * （codeLines > 500）——本仓的惯例是**抽出去**而不是放宽阈值；顺带也让"表数据"与"解析器"两件事分开。
 *
 * ## 维护规则（由 `tests/unit/knownFlags.test.ts` 机械核对，不靠自觉）
 *
 * 1. 新增子命令旗标 ⇒ 本表补一行（判据①：源码里任何 `reader.value(...)` 式的字面旗标读取都必须被认识）；
 * 2. 已在 `FLAG_TABLE` / `VALUE_FLAGS` 的名字**不得**重复登记（判据②：防两处各写一份而漂移）；
 * 3. 本表出现但全仓无人读取 ⇒ 判据红（判据③：防它腐化成"什么都放行"的白名单）。
 */
export const KNOWN_EXTRA_FLAGS: ReadonlySet<string> = new Set([
  // 装配层在 parseArgs 之前自行扫描（runServe）。注意 `--config` / `--profile` / `--tool`
  // **已在 VALUE_FLAGS**（那本就是"取值型旗标"清单），故不在此重复——判据②会拒绝重复登记。
  '--auth-required',
  // serve / server
  '--port',
  '--dir',
  '--allow',
  '--catalog',
  // 凭据 / 身份 / 授权码流
  '--client-id',
  '--client-secret',
  '--issuer',
  '--redirect-uri',
  '--private-key',
  '--runtime-id',
  '--payload',
  '--signature',
  '--scope',
  '--state',
  '--code',
  '--submission',
  '--license',
  '--license-public-key',
  '--verify',
  '--sign-key',
  '--skill',
  '--pack',
  '--trust',
  '--source',
  '--loose',
  '--declare',
  '--sandbox-level',
  '--allow-unsigned',
  '--yes',
  // 存储 / 保险库 / kv
  '--key',
  '--value',
  '--prefix',
  '--name',
  '--vault-backend',
  '--key-file',
  '--out-dir',
  '--out',
  // 审计 / 追溯 / sdk（`--audit-dir` / `--audit-file` / `--audit-hmac-key` **在 VALUE_FLAGS**：
  // 它们取值为路径/密钥，必须走取值型清单以免取值被当成 prompt；判据②会拒绝重复登记）
  '--actor',
  '--since',
  '--until',
  '--type',
  '--session',
  '--limit',
  '--format',
  '--server',
  '--args',
  '--url',
  '--method',
  '--params',
  '--call-id',
  '--timeout',
  // goal / workflow / routines / tui
  '--goal',
  '--goal-max-iterations',
  '--file',
  '--every',
  '--cron',
  '--iterations',
  // lsp / 代码导航 / 自省
  '--line',
  '--col',
  '--desc',
  '--plugin',
  '--query',
  '--kind',
  '--json',
  '--seq',
  '--out-md',
  '--out-py',
  '--out-ts',
]);
