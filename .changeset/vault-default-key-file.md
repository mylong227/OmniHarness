---
'@mylong227/omniharness': minor
---

凭据保险库改用**用户级默认主密钥文件** `~/.omniharness/vault.key`（首次使用时生成，0600），并修掉一处「半接线」。

## 之前是什么样（实测 footgun）

`CryptoVault` 的主密钥来源有三档：环境变量 → 密钥文件 → **内存随机**。第三档在 `keyFile` 未配置时**不落盘**
⇒ `vault set` 当次看着成功，**进程一退，密钥随之消失，写下的密文永久读不回**（GCM 认证失败）。

serve 侧因此**拒绝注入保险库**（注入了只会显示"能用但永远读空"，用户会以为凭据丢了），启动横幅也就常驻
`ℹ️ 凭据保险库未接线（设 OMNIHARNESS_VAULT_KEY 或 --vault-key-file 后重启…）`——即"Web 端凭据管理"默认不可用。

## 现在

- **默认主密钥文件**：无显式来源时用 `~/.omniharness/vault.key`（首次使用时生成，权限 0600，与 `--vault-key-file` 同规格）。
  优先级：**`OMNIHARNESS_VAULT_KEY` > 显式 `--vault-key-file` > 默认密钥文件**。
- **`OMNIHARNESS_VAULT=0`**（`0` / `off` / `false`）：彻底关闭保险库——**不创建任何密钥文件**，Web 端如实显示"未接线"。
- **启动横幅如实报来源**：`🔐 凭据保险库已接线：主密钥来自密钥文件 …` / `环境变量 OMNIHARNESS_VAULT_KEY`（**不含密钥内容**）。
- **修掉一处「半接线」**：`--vault-hydrate` 此前要求"环境变量或 `--vault-key-file` 二选一"，否则跳过——而 serve
  已随默认密钥文件默认接线 ⇒ 同一进程两种口径：serve 能读写保险库，水合却以"缺少主密钥来源"一句跳过
  （实测：保险库里就存着 `OPENAI_API_KEY` 也照样跳过）。现在两边**共用同一套来源解析**（`VaultKeyDefaults.resolveKeyFile`），
  `OMNIHARNESS_VAULT=0` 一并跳过。
- **水合失败不再冒充"没存过"**：读取失败时上抛，并把密码学真相翻成人话——**点名主密钥来源**并说明"换了密钥来源后旧密文必然解不开"。

## 迁移注意（诚实登记）

以前用"内存随机密钥"写下的密文**本来就不可恢复**（密钥从未落盘）。换成默认密钥文件后，读那些条目会**明确报错**
（fail-closed），而**不会**返回错误明文——这是刻意的：宁可报错，也不让调用方拿到错误的凭据。

## 判据

- `tests/unit/vaultKeyDefaults.test.ts`（7 例）：默认路径/显式优先/来源描述不带密钥、**跨进程持久化**
  （真起 CLI 子进程：A `set` → B `get` 必须取回，修前必红）、正对照（换 HOME 后读不回且**不返回错误明文**）、
  环境变量优先（换密钥必报错、同密钥必读回）、`OMNIHARNESS_VAULT=0` 不建密钥文件、
  `--vault-hydrate` 默认真能水合（修前必红）、`OMNIHARNESS_VAULT=0` 下水合如实说明跳过。
- `tests/unit/cliCredentialHydration.test.ts`（6 例，其中 2 例改口径）：含"不得再因无显式主密钥来源短路"的源码断言 + 变异正对照。
- `web/test/vaultTab.test.mjs`：未接线提示必须指向 `OMNIHARNESS_VAULT=0` / 默认密钥文件，且**不得**渲染成"保险库为空"。
