# 在本機開練習站（不需要網路）。網址 http://localhost:8800
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot '_common.ps1')
Set-Location (Split-Path $PSScriptRoot -Parent)
$PY = Resolve-Python
if (-not $PY) {
  Write-Host "找不到 Python，先跑一次「install.bat」。" -ForegroundColor Red
  Read-Host "按 Enter 關閉"; exit 1
}
Write-Host "練習站開在 http://localhost:8800" -ForegroundColor Green
Write-Host "這個視窗關掉就會停止。手機要用的話請用 site-url.txt 裡的那個網址。"
Start-Process "http://localhost:8800"
Invoke-Py $PY @('-m','http.server','8800','--directory','docs')
