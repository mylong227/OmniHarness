# 0010 信任-隔离阶梯（档位不可达即拒执行）

- 日期：2026-10-04
- 状态：已接受（实施规格见 [../EVOLVIX_SPEC_2026-10.md](../EVOLVIX_SPEC_2026-10.md) §6 矩阵 / §4 F3；波浪路线见 [../ARCHITECTURE_TARGET_2026-10.md](../ARCHITECTURE_TARGET_2026-10.md) §7）
- 前置：Wave B（[ADR-0009](./0009-capability-protocol.md)）——资产的信任档/隔离档已在协议里

## 背景

Wave B 把 `TrustTier` / `IsolationLevel` 写进了资产协议（并且「只可收紧」已由注册表强制），
但**没有执行面**：档位目前只是记录上的一个字段，没有任何东西按它去跑资产。
Wave C 要补的是「按档位执行」这件事本身：`core`（进程内）→ `signed`（`node:vm`）→
`evolved`（wasm）→ OS 沙箱。

仓内已有两件可直接复用的资产：

- `src/plugin/sandbox.ts`：`node:vm` 受限上下文 + **V8 vm timeout（能真正打断同步死循环）**，
  并已如实标注边界（跨过首个 `await` 之后的同步死循环无法就地中止）；
- `CapabilityRecord.governance.isolation`：资产自己声明的档位。

缺的是 wasm 运行时（`wasmtime` 需 Rust 依赖 + 原生构建，属 D10 准入事项，本波不动）。

## 决策

1. **端口形状按载荷分派**：`IsolationPort.run({ level, asset, payload })`，`payload` 三型
   —— `closure`（宿主闭包）/ `js-source`（源码文本）/ `wasm-module`（字节 + fuel）。
   **为什么不能只有闭包型**：宿主闭包（闭在 `Benchmark.moireEnergy` 等模块上的函数）**无法**搬进
   另一个 realm——把它塞进 `vm` 只会得到一个假的隔离。故闭包型只允许 `in-process` 档，
   在更严档位上请求闭包 ⇒ `payload-unsupported` 拒执行（而不是假装隔离了）。
2. **档位不可达 ⇒ 拒绝执行**（ADR-0006 诚实降级的同一取向）：本波 `wasm` 档**如实申报不可达**
   （`level-unavailable`，原因写明「wasmtime 未准入」），任何落到该档的请求一律拒，**绝不静默降档**。
   `os-sandbox` 档需要组合根注入一个档位原生执行器（`os-runner`）；未注入即拒。
3. **档位只可收紧**：请求档位默认取资产声明的 `governance.isolation`；**请求比声明更松** ⇒
   `downgrade-not-allowed`（默认）。放宽必须由组合根显式配置 `allowDowngrade: true`
   ——与 ADR-0009 决策 6「放宽没有隐式路径」同一条纪律。
4. **每次执行都给可读结论**：成功回 `{ ok: true, value, level, fuelUsed? }`；失败回
   `{ ok: false, denied: { code, reason, level } }`，`code` 为可机读的少数枚举
   （`level-unavailable` / `payload-unsupported` / `downgrade-not-allowed` / `timeout` / `trap` / `escape`）。
5. **逃逸是「拒绝」不是「警告」**：`vm` 档的受限上下文不注入 `require` / `process` / `module` /
   `fetch` / `globalThis`（与插件沙箱同口径）；探针发现宿主能力可达 ⇒ `escape` 拒执行。
6. **诚实边界写进代码注释**：`node:vm` 是 **best-effort**，不是安全边界（沿 ADR-0006 与
   `plugin/sandbox.ts` 的既有表述）；真正的强隔离要么 wasm（等 wasmtime 准入），要么独立进程。

## 后果

- 正面：档位从「记录里的字段」变成「执行时的门」；F3（资产安装）里那步「沙盒内 evalContract 冒烟」
  有了可用实现；不可达档位的拒绝路径有可读原因，运维能分辨「拒装因为档位没实现」与「因为资产坏」。
- 负面：`wasm` 档暂时只有「拒执行」这一种行为（判据只能钉拒绝路径，**逃逸/fuel 那条 J8 要等 wasmtime**）；
  `vm` 档对异步悬挂只能靠 `Promise.race` 兜（同步段才是 V8 真正能打断的）。
- 边界：不做独立进程/Worker 隔离（成本与形态不匹配单人维护）；不做内存/CPU 计量（那是 wasm 档的事）。

## 替代方案

- **只有闭包型载荷**——拒绝：闭包无法跨 realm，`vm` 档会退化成「假装隔离」；
  实测把宿主闭包塞进 `vm` 上下文后它照样闭在宿主模块上。
- **档位不可达时按最接近的可用档降级执行**——拒绝：这正是 ADR-0006 要禁的静默降档，
  而且会把「signed 资产实际跑在进程内」这件事藏起来。
- **本波直接引 wasmtime**——拒绝（本轮）：Rust crate + 原生构建是独立准入事项（D10 六门 + 体积/工具链），
  在没有真实 wasm 载荷需求前引入属「为能力而能力」；等有真实 `evolved` 资产时再按 §5 A 级流程走。
- **复用 `plugin/sandbox.ts` 的插件加载器做资产执行**——部分复用其技术（受限上下文 + vm timeout），
  但它的输入是「插件源码 + `export default`」且返回插件对象，与「资产载荷」形状不匹配，故只借鉴不照搬。
