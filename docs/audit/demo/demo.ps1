# audit 60 秒演示（PLAN_2026-11.md P2 T2.1，PowerShell 版）——与 demo.sh 同一套三段契约：
#   ① 出一份自带哈希链的报告（无输入时自动生成合成会话，零依赖可跑）
#   ② audit verify：链完整，exit 0
#   ③ 改报告里一个显示字：verify 必须变红（exit 1）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File docs\audit\demo\demo.ps1 [会话文件.jsonl]
#   $env:OMNI_AUDIT_CLI = "npx -y @mylong227/omniharness audit"; powershell -File docs\audit\demo\demo.ps1
#
# 任何一段行为不符退出码契约（docs/audit/EXIT_CODES.md）⇒ 本脚本 exit 1。
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

# CLI 解析：环境变量显式指定 > 仓内 dist > 全局安装 > npx（发布后形态）。
# 退出码不在这里判定——三段各自的预期不同（① 0 / ② 0 / ③ 非 0），由调用点检查。
function Invoke-Audit {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $AuditArgs)
  $global:LAST_AUDIT_EXIT = 0
  if ($env:OMNI_AUDIT_CLI) {
    Invoke-Expression "$($env:OMNI_AUDIT_CLI) $($AuditArgs -join ' ')"
    $global:LAST_AUDIT_EXIT = $LASTEXITCODE
  } elseif (Test-Path (Join-Path $Repo 'dist\src\apps\cli\exec.js')) {
    node (Join-Path $Repo 'dist\src\apps\cli\exec.js') audit @AuditArgs
    $global:LAST_AUDIT_EXIT = $LASTEXITCODE
  } elseif (Get-Command omniharness -ErrorAction SilentlyContinue) {
    omniharness audit @AuditArgs
    $global:LAST_AUDIT_EXIT = $LASTEXITCODE
  } else {
    npx -y '@mylong227/omniharness' audit @AuditArgs
    $global:LAST_AUDIT_EXIT = $LASTEXITCODE
  }
}

# 会话解析：位置参数 > 仓内夹具 > 现场生成合成会话。
$Session = $args[0]
if (-not $Session) {
  $Fixture = Join-Path $Repo 'tests\fixtures\audit\omni.jsonl'
  if (Test-Path $Fixture) {
    $Session = $Fixture
  } else {
    $Session = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-demo-" + [guid]::NewGuid() + ".jsonl")
    @'
{"id":"d1","type":"session_meta","sessionId":"demo-1","timestamp":"2026-11-04T10:00:00.000Z","payload":{"workspace":"/demo","model":"deepseek-v4-flash"},"seq":1}
{"id":"d2","type":"user","sessionId":"demo-1","timestamp":"2026-11-04T10:00:01.000Z","payload":{"content":"把 src/tax.ts 的税率从 0.1 改成 0.15"},"seq":2}
{"id":"d3","type":"assistant","sessionId":"demo-1","timestamp":"2026-11-04T10:00:02.000Z","payload":{"content":"先读文件再改。"},"seq":3}
{"id":"d4","type":"tool_call","sessionId":"demo-1","timestamp":"2026-11-04T10:00:03.000Z","payload":{"callId":"c1","name":"edit_file","args":{"path":"src/tax.ts","old":"0.1","new":"0.15"}},"seq":4}
{"id":"d5","type":"tool_result","sessionId":"demo-1","timestamp":"2026-11-04T10:00:04.000Z","payload":{"callId":"c1","ok":true,"output":"1 file updated"},"seq":5}
{"id":"d6","type":"turn_diff","sessionId":"demo-1","timestamp":"2026-11-04T10:00:05.000Z","payload":{"diff":"diff --git a/src/tax.ts b/src/tax.ts\n--- a/src/tax.ts\n+++ b/src/tax.ts\n@@ -1 +1 @@\n-TAX = 0.1\n+TAX = 0.15\n"},"seq":6}
'@ | Set-Content -Path $Session -Encoding utf8
    Write-Host "（未给会话输入 ⇒ 已生成合成会话：$Session）"
  }
}

$OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-demo-out-" + [guid]::NewGuid())
$Report = Join-Path $OutDir 'demo-report.html'

Write-Host '═══ ① 出证：audit <会话文件> --out report.html'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Invoke-Audit $Session --out $Report --title '演示报告'
if ($global:LAST_AUDIT_EXIT -ne 0) {
  Write-Host "✗ ① 失败：出证以退出码 $($global:LAST_AUDIT_EXIT) 结束"
  exit 1
}
Write-Host ''

Write-Host '═══ ② 复核：audit verify report.html（应显示「链完整」，退出码 0）'
Invoke-Audit verify $Report
if ($global:LAST_AUDIT_EXIT -ne 0) {
  Write-Host "✗ ② 失败：干净报告 verify 意外不通过（exit $($global:LAST_AUDIT_EXIT)）"
  exit 1
}
Write-Host '✓ ② 通过：报告自生成起未被改动'
Write-Host ''

Write-Host '═══ ③ 篡改：改报告里一个显示字（演示报告 → 伪造报告），verify 必须变红'
(Get-Content $Report -Raw) -replace '演示报告', '伪造报告' | Set-Content $Report -Encoding utf8
Invoke-Audit verify $Report
if ($global:LAST_AUDIT_EXIT -ne 0) {
  Write-Host "✓ ③ 通过：一个显示字都瞒不过文件级自指纹（exit $($global:LAST_AUDIT_EXIT) = 证据失败）"
} else {
  Write-Host '✗ ③ 失败：篡改后的报告 verify 意外通过——完整性检测失效！'
  exit 1
}

Write-Host ''
Write-Host '═══ 演示完成：三段行为全部符合退出码契约（docs/audit/EXIT_CODES.md）。'
Write-Host "    报告在 $Report（已被 ③ 改坏——正好看它怎么报红；重新跑 ① 即得干净版）。"
