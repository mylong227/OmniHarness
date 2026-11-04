#!/usr/bin/env bash
# audit 60 秒演示（PLAN_2026-11.md P2 T2.1）——三段把「出证 → 复核 → 篡改必现形」跑给你看：
#   ① 出一份自带哈希链的报告（无输入时自动生成合成会话，零依赖可跑）
#   ② audit verify：链完整，exit 0
#   ③ 改报告里一个显示字：verify 必须变红（exit 1）——这就是它与「好看的报表」的分界线
#
# 用法：
#   bash docs/audit/demo/demo.sh [会话文件.jsonl]
#   OMNI_AUDIT_CLI="npx -y @mylong227/omniharness audit" bash docs/audit/demo/demo.sh
#
# 全程按退出码契约自检（docs/audit/EXIT_CODES.md）：任何一段行为不符 ⇒ 本脚本 exit 1。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

# CLI 解析：环境变量显式指定 > 仓内 dist > 全局安装 > npx（发布后形态）。
run_audit() {
  if [ -n "${OMNI_AUDIT_CLI:-}" ]; then
    ${OMNI_AUDIT_CLI} "$@"
  elif [ -f "$REPO/dist/src/apps/cli/exec.js" ]; then
    node "$REPO/dist/src/apps/cli/exec.js" audit "$@"
  elif command -v omniharness >/dev/null 2>&1; then
    omniharness audit "$@"
  else
    npx -y @mylong227/omniharness audit "$@"
  fi
}

# 会话解析：位置参数 > 仓内夹具 > 现场生成合成会话（"agent 改了税率"的最小故事）。
SESSION="${1:-}"
if [ -z "$SESSION" ]; then
  if [ -f "$REPO/tests/fixtures/audit/omni.jsonl" ]; then
    SESSION="$REPO/tests/fixtures/audit/omni.jsonl"
  else
    SESSION="$(mktemp -d)/demo-session.jsonl"
    cat > "$SESSION" <<'EOF'
{"id":"d1","type":"session_meta","sessionId":"demo-1","timestamp":"2026-11-04T10:00:00.000Z","payload":{"workspace":"/demo","model":"deepseek-v4-flash"},"seq":1}
{"id":"d2","type":"user","sessionId":"demo-1","timestamp":"2026-11-04T10:00:01.000Z","payload":{"content":"把 src/tax.ts 的税率从 0.1 改成 0.15"},"seq":2}
{"id":"d3","type":"assistant","sessionId":"demo-1","timestamp":"2026-11-04T10:00:02.000Z","payload":{"content":"先读文件再改。"},"seq":3}
{"id":"d4","type":"tool_call","sessionId":"demo-1","timestamp":"2026-11-04T10:00:03.000Z","payload":{"callId":"c1","name":"edit_file","args":{"path":"src/tax.ts","old":"0.1","new":"0.15"}},"seq":4}
{"id":"d5","type":"tool_result","sessionId":"demo-1","timestamp":"2026-11-04T10:00:04.000Z","payload":{"callId":"c1","ok":true,"output":"1 file updated"},"seq":5}
{"id":"d6","type":"turn_diff","sessionId":"demo-1","timestamp":"2026-11-04T10:00:05.000Z","payload":{"diff":"diff --git a/src/tax.ts b/src/tax.ts\n--- a/src/tax.ts\n+++ b/src/tax.ts\n@@ -1 +1 @@\n-TAX = 0.1\n+TAX = 0.15\n"},"seq":6}
EOF
    echo "（未给会话输入 ⇒ 已生成合成会话：$SESSION）"
  fi
fi

OUTDIR="$(mktemp -d)"
REPORT="$OUTDIR/demo-report.html"

echo "═══ ① 出证：audit <会话文件> --out report.html"
run_audit "$SESSION" --out "$REPORT" --title "演示报告"
echo

echo "═══ ② 复核：audit verify report.html（应显示「链完整」，exit 0）"
if run_audit verify "$REPORT"; then
  echo "✓ ② 通过：报告自生成起未被改动"
else
  echo "✗ ② 失败：干净报告 verify 意外不通过"
  exit 1
fi
echo

echo "═══ ③ 篡改：改报告里一个显示字（演示报告 → 伪造报告），verify 必须变红"
sed -i.bak 's/演示报告/伪造报告/' "$REPORT"
rm -f "$REPORT.bak"
if run_audit verify "$REPORT"; then
  echo "✗ ③ 失败：篡改后的报告 verify 意外通过——完整性检测失效！"
  exit 1
else
  echo "✓ ③ 通过：一个显示字都瞒不过文件级自指纹（exit 1 = 证据失败）"
fi
echo

echo "═══ 演示完成：三段行为全部符合退出码契约（docs/audit/EXIT_CODES.md）。"
echo "    报告在 $REPORT（已被 ③ 改坏——正好看它怎么报红；重新跑 ① 即得干净版）。"
