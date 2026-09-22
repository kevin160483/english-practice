# 每週跑這個：處理 inbox 裡的新課程，把加密結果推上網站。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
. (Join-Path $PSScriptRoot '_common.ps1')
Set-Location (Split-Path $PSScriptRoot -Parent)
$root = Get-Location

function Say($t)  { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function OK($t)   { Write-Host "   [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host ""; Write-Host "[X] $t" -ForegroundColor Red; Write-Host "把這段訊息複製給 Claude。"; exit 1 }

Write-Host "處理新課程" -ForegroundColor White

# ---------- 檢查 ----------
$PY = Resolve-Python
if (-not $PY) { Die "找不到 Python。先跑一次「install.bat」。" }
$pwFile = Join-Path $root 'password.txt'
if (-not (Test-Path $pwFile)) { Die "找不到 password.txt。先跑一次「install.bat」。" }
$env:LESSON_PASSWORD = ([System.IO.File]::ReadAllText($pwFile)).Trim()

$docs = @(Get-ChildItem inbox -Filter *.doc* -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '~$*' })
$hasNewLesson = ($docs.Count -gt 0)

if (-not $hasNewLesson) {
  Warn "inbox 資料夾裡沒有新講義，跳過處理。"
  Write-Host "   （如果你只是改了介面，下面還是會把變更上傳）"
  Write-Host ""
  Write-Host "   要加新課程的話，把這兩個檔案放進 inbox 再跑一次："
  Write-Host "     講義：例如 L3.docx"
  Write-Host "     錄音：例如 L3.mp4 或 L3.m4a（檔名要跟講義一樣）"
  Write-Host "   沒有錄音也可以，只放講義，範讀會用合成語音。"
}

$media = @(Get-ChildItem inbox -ErrorAction SilentlyContinue | Where-Object {
  $_.Extension -match '^\.(m4a|mp3|mp4|wav|mov|aac|ogg|opus|webm|mkv)$' })

if ($hasNewLesson) {
  Say "找到的檔案"
  foreach ($d in $docs)  { Write-Host "   講義  $($d.Name)" }
  foreach ($m in $media) { Write-Host "   錄音  $($m.Name)  ($([math]::Round($m.Length/1MB,1)) MB)" }
}

# ---------- 壓縮錄音（縮短辨識時間，原檔保留） ----------
$env:WHISPER_MODEL = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { 'small.en' }
foreach ($m in $(if ($hasNewLesson) { $media } else { @() })) {
  if ($m.Length -gt 25MB) {
    $small = Join-Path $m.DirectoryName ($m.BaseName + '.prepared.m4a')
    if (-not (Test-Path $small)) {
      Say "壓縮 $($m.Name)（只取聲音，加快辨識）"
      ffmpeg -loglevel error -y -i $m.FullName -vn -ac 1 -ar 16000 -c:a aac -b:a 24k $small
      if (Test-Path $small) {
        OK "$([math]::Round((Get-Item $small).Length/1MB,1)) MB"
        Move-Item $m.FullName (Join-Path $m.DirectoryName ($m.Name + '.original')) -Force
        Rename-Item $small ($m.BaseName + $m.Extension)
      } else { Warn "壓縮失敗，直接用原檔處理" }
    }
  }
}

# ---------- 處理 ----------
if ($hasNewLesson) {
  Say "開始處理（辨識 + 切句 + 合成 + 加密）"
  Write-Host "   一小時的錄音大約 20-40 分鐘，中間不用管它。"
  Write-Host ""
  Invoke-Py $PY @('scripts\process_inbox.py')
  if ($LASTEXITCODE -ne 0) { Die "處理過程出錯，上面有訊息。inbox 裡的檔案還在，修好後可以再跑一次。" }
}

# ---------- 上傳 ----------
Say "上傳到網站"
if (-not (Test-Path (Join-Path $root '.git'))) { Warn "還沒連 GitHub，跳過上傳。先跑「install.bat」。"; exit 0 }
git add docs
$changed = git diff --cached --quiet; $hasChange = ($LASTEXITCODE -ne 0)
if (-not $hasChange) {
  Warn "沒有新內容（網站已經是最新的）"
} else {
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  git -c user.name="lesson-bot" -c user.email="lesson-bot@users.noreply.github.com" commit -q -m "課程更新 $stamp"
  git push -q
  if ($LASTEXITCODE -ne 0) { Die "上傳失敗。可能是 GitHub 登入過期，執行 gh auth login 重新登入，或再跑一次這個檔案。" }
  OK "上傳完成，網站一兩分鐘後更新"
}

# ---------- 清理 ----------
if ($hasNewLesson) {
  Say "整理 inbox"
  $done = Join-Path $root 'inbox\done'
  New-Item -ItemType Directory -Force -Path $done | Out-Null
  Get-ChildItem inbox -File | Where-Object { $_.Name -ne 'README.md' } | ForEach-Object {
    Move-Item $_.FullName (Join-Path $done $_.Name) -Force
  }
  OK "原始檔案移到 inbox\done（留在你電腦，沒有上傳）"
}

$urlFile = Join-Path $root 'site-url.txt'
$site = if (Test-Path $urlFile) { ([System.IO.File]::ReadAllText($urlFile)).Trim() } else { '（見 site-url.txt）' }
Write-Host ""
Write-Host "完成。打開這個網址就能練：" -ForegroundColor Green
Write-Host "   $site" -ForegroundColor White
