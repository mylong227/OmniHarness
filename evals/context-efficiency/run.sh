#!/usr/bin/env bash
# 复现上下文效率基准：编译三个零依赖模块到 .xeval，再跑基准。
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
./node_modules/.bin/tsc src/search/bm25.ts src/context/repoMap.ts src/context/contextEngine.ts \
  --outDir .xeval --module esnext --target es2022 --moduleResolution bundler --skipLibCheck
node evals/context-efficiency/bench.mjs src
