---
'omniharness': patch
---

修掉两条 CI 门禁的本地红灯，并把内核编码修复在本机端到端验证完毕。

- `npm audit --audit-level=high` 原报 4 个 high：全部来自可选依赖 `@huggingface/transformers` 的传递
  依赖。用 npm `overrides` 钉到已修版本：`sharp@^0.35.4`（原 0.34.5 命中 libvips/libheif 公告）、
  `adm-zip@^0.6.1`（原 0.5.x 命中 zip 解压内存放大/符号链接覆盖公告）⇒ 现在 `npm audit` 报
  **found 0 vulnerabilities**。语义嵌入真机复验仍正常（pipeline 0.4s，区分度 gap 0.0779）。
- `npm run format:check` 原对 28 个文件报红，现全量格式化后为 `All matched files use Prettier code style!`。
- 本机补齐 Rust 工具链（rustup + rsproxy 的 `stable-x86_64-pc-windows-gnu`，复用仓库自带
  `.cargo/config.toml` 的 rsproxy 源与 `rust-lld`）后重编内核：`cargo fmt --check` /
  `clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` 全绿；
  `nativeAliasBridge` 由「产物过期 skip」变为 3/3 实跑通过，真机 `echo 别名桥-ok` 回传正确中文
  （此前 `鍒悕妗?ok`）。
