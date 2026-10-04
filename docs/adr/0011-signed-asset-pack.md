# 0011 签名资产包分发（Ed25519 非对称 + 严格档 fail-closed）

- 日期：2026-10-04
- 状态：已接受（实施规格见 [../EVOLVIX_SPEC_2026-10.md](../EVOLVIX_SPEC_2026-10.md) §4 F3 / §7 A 级依赖接入点；波浪路线见 [../ARCHITECTURE_TARGET_2026-10.md](../ARCHITECTURE_TARGET_2026-10.md) §7）
- 前置：Wave B（[ADR-0009](./0009-capability-protocol.md)）——资产协议与注册表已就位

## 背景

Wave B 让「一切能力成为统一资产」，但资产目前只能在**本进程内**注册。L4 分发层要回答的是
「别人做的资产怎么安全地进来」。仓内已有两件相关资产：

- `bundle pack/unpack`（`src/plugin/pluginBundler.ts`）：`.ohb` = zip + `bundle.json` + **HMAC-SHA256**（对称密钥来自本地 key file）；
- `Ed25519AgentIdentity`（`src/adapters/identity/ed25519AgentIdentity.ts`）：`node:crypto` 原生 Ed25519 身份，`sign(payload)` / `verify(payload, sig)` / `publicKeySsh()`。

**HMAC 对称密钥不适合分发**：验签方必须持有同一把密钥，于是「谁能验签」等于「谁能伪造」；
而且既有 `unpackBundle` 的校验是**条件式**的——只有「清单带签名**且**调用方给了 keyFile」才校验，
带签名的包在没给 keyFile 时被静默接受（fail-open）。分发路径上这条默认值不能留。

## 决策

1. **容器复用、清单独立**：资产包仍是 `.ohb`（zip 容器，复用 `Zip.zipStore/unzip`），
   但清单是 `asset-pack.json`（**不是** `bundle.json`）——容器同构、语义隔离，避免两种发布单元互相误读。
2. **Ed25519 非对称签名**：签名对象是清单的**规范化正文**（固定键序、排除 `signature` 自身）；
   验签用清单里 `publisher.publicKeySsh` 的**发布者公钥**（不是验签方自己的私钥）——
   这才让「第三方可独立验签」成立。签名复用既有身份端口（`sign` / `publicKeySsh`），
   本波**零新依赖**（`node:crypto` 原生 Ed25519）。
3. **严格档默认开启**：`install` 默认 `requireSignature: true`——无签名的包一律拒（J9 第一类）；
   非严格档（显式 `requireSignature: false`）只用于本地开发，装入资产一律记 `trustTier: 'external'`
   并在 `InstallReport` 里标 `unsigned: true`（**不假装它是签过名的**）。
4. **整包原子**：先做全量预检（验签 → 逐资产 `Schema.validate` → 逐资产档位计算 → 重名检测），
   **全部通过后才写入**；任一失败即整包拒，绝不留下半个包（补偿式回滚仅在写入期意外异常时使用）。
5. **档位只可收紧**：包内声明的信任/隔离档只能比「类型默认档与装配下限的更严者」更严；
   想放宽 ⇒ 整包拒（不静默取交集、不静默忽略）。
6. **安装必留台账**：安装成功写一条 `action: 'pack-install'` 条目（名 + 来源 `pack:<publisherId>`）；
   **无台账即拒装**（沿 ADR-0008/0009 的同一条纪律：无账不生效）。
7. **元数据导出**：`metadataFor(kind)` 产出 MCP Registry 字段风格的只读元数据（名称/版本/类型/档位/资产清单），
   供生态互描述；本波只落**导出**，不落远程注册表客户端（那属真实生态接入，未做即如实登记）。

## 后果

- 正面：分发有了可独立验签的底座（非对称、无共享密钥），且默认 fail-closed；
  与 Wave B 的注册表/台账/档位纪律直接对接（安装 = 一批受治理资产入册）。
- 负面：`.ohb` 现在有两种清单（`bundle.json` 插件包 / `asset-pack.json` 资产包），
  读取方必须按清单名分派（`AssetPackCodec.decode` 会对此显式报错，不猜）；
  签名只覆盖清单正文，**载荷（zip 内其它条目）目前不在签名范围内**——v1 的资产是清单内联 JSON，
  故等价；将来若包内引入独立文件，必须把文件摘要纳入清单后再签（本 ADR 记为已知边界）。
- 边界（沿反泡沫清单）：不做远程注册表客户端 / 不做包内容加密 / 不做跨资产原子事务。

## 替代方案

- **沿用 HMAC 对称签名**——拒绝：分发场景下验签方必须持有签名密钥，等于把伪造能力一起发出去；
  且既有校验是条件式的（fail-open）。
- **把资产包做成纯 JSON 单文件（不套 zip）**——拒绝：`.ohb` 已是仓内发布单元容器，
  再引入第二个 `.ohb` 语义会让读取方靠猜（sniffing）分派。
- **新增第三方签名库（如 `jose`）**——拒绝：`node:crypto` 原生 Ed25519 已足够，
  且 D10 要求「必要且更优」才引依赖；此处自研只是 20 行密钥编解码，属「已更优」的合法维持。
- **验签失败时降级为「未签名可用」**——拒绝：那是把 fail-closed 边界换成 fail-open，
  正是本 ADR 要修掉的那条默认值。
