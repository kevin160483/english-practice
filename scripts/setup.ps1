# 一次性安裝：裝好工具、設定密碼、建立網站。跑完就不用再跑。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
Set-Location (Split-Path $PSScriptRoot -Parent)
$root = Get-Location

function Say($t)  { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function OK($t)   { Write-Host "   [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host ""; Write-Host "[X] $t" -ForegroundColor Red; Write-Host "把這段訊息複製給 Claude，他會告訴你怎麼處理。"; exit 1 }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

. (Join-Path $PSScriptRoot '_common.ps1')

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path','Machine')
  $u = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$m;$u"
}

Write-Host "英文口說練習站 - 安裝" -ForegroundColor White
Write-Host "這個程式會安裝需要的工具、幫你建立網站。中途可能會跳出安裝視窗，讓它跑完就好。"

# ---------- 1. winget ----------
Say "檢查系統"
if (-not (Have 'winget')) {
  Die "找不到 winget（Windows 內建的安裝工具）。請先從 Microsoft Store 更新「應用程式安裝程式 / App Installer」，再重新執行這個檔案。"
}
OK "winget 可用"

# ---------- 2. Python ----------
Say "安裝 Python"
$PY = Resolve-Python
if ($PY) {
  OK "找到了（$($PY.Exe)）"
} else {
  Write-Host "   安裝中，下面會顯示進度。跳出「使用者帳戶控制」就按「是」。" -ForegroundColor Yellow
  winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  $PY = Resolve-Python
  if ($PY) { OK "裝好了（$($PY.Exe)）" }
  else {
    Write-Host ""
    Write-Host "[X] 裝了 Python 但還是叫不動它。" -ForegroundColor Red
    Write-Host "    最常見的原因是 Windows 的「應用程式執行別名」把 python 指向微軟商店的空捷徑。"
    Write-Host "    請這樣處理："
    Write-Host "      1. 開始功能表搜尋「應用程式執行別名」"
    Write-Host "      2. 把 python.exe 和 python3.exe 兩個關掉"
    Write-Host "      3. 關掉這個視窗，重新雙擊 install.bat"
    exit 1
  }
}

# ---------- 2b. 其他工具 ----------
$tools = @(
  @{ Cmd='ffmpeg'; Id='Gyan.FFmpeg'; Name='ffmpeg（處理音檔）'; Note='約 150MB，網路慢的話要 5-10 分鐘' },
  @{ Cmd='git';    Id='Git.Git';     Name='Git';               Note='' },
  @{ Cmd='gh';     Id='GitHub.cli';  Name='GitHub CLI';        Note='' }
)
foreach ($t in $tools) {
  Say "安裝 $($t.Name)"
  if (Have $t.Cmd) {
    OK "已經有了，跳過"
  } else {
    if ($t.Note) { Write-Host "   $($t.Note)" }
    Write-Host "   跳出「使用者帳戶控制」就按「是」。" -ForegroundColor Yellow
    winget install --id $t.Id -e --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (Have $t.Cmd) { OK "裝好了" }
    else {
      Warn "$($t.Name) 裝好了，但這個視窗還看不到它（Windows 的 PATH 要重開才生效）。"
      Write-Host "   請關掉這個視窗，重新雙擊 install.bat 一次。還是不行就重開機再試。"
      Write-Host "   （已經裝好的部分不會重做）"
      exit 1
    }
  }
}

# ---------- 3. Python 套件 ----------
Say "安裝 Python 套件（語音辨識、語音合成、加密）"
Write-Host "   第一次會下載約 200MB，請稍等…"
Invoke-Py $PY @('-m','pip','install','--quiet','--upgrade','pip')
Invoke-Py $PY @('-m','pip','install','--quiet','-r','requirements.txt')
if ($LASTEXITCODE -ne 0) { Die "Python 套件安裝失敗。把上面的紅字訊息給 Claude 看。" }
OK "套件齊了"

# ---------- 4. 語音模型 ----------
Say "下載範讀語音"
Invoke-Py $PY @('-c', "import sys; sys.path.insert(0,'scripts'); import tts_fallback as t; t.ensure_voice()")
if ($LASTEXITCODE -ne 0) { Die "語音模型下載失敗，可能是網路問題，再跑一次試試。" }
OK "語音模型就緒"

# ---------- 5. 密碼 ----------
Say "設定練習站密碼"
$pwFile = Join-Path $root 'password.txt'
if (Test-Path $pwFile) {
  OK "已經設過了（存在 password.txt）"
} else {
  Write-Host "   這個密碼用來加密講義和音檔。網站放在網路上，但沒有密碼的人只會看到亂碼。"
  Write-Host "   建議用四個英文單字組起來，例如 copper-lantern-drift-84。不要用生日或常見密碼。" -ForegroundColor Yellow
  Write-Host "   忘記就打不開舊課程，請存進密碼管理器。" -ForegroundColor Yellow
  do {
    $p1 = Read-Host "   輸入密碼"
    if ($p1.Length -lt 10) { Warn "太短了，至少 10 個字"; continue }
    $p2 = Read-Host "   再輸入一次確認"
    if ($p1 -ne $p2) { Warn "兩次不一樣，重來" }
  } while ($p1.Length -lt 10 -or $p1 -ne $p2)
  [System.IO.File]::WriteAllText($pwFile, $p1, [System.Text.UTF8Encoding]::new($false))
  OK "密碼存好了（這個檔案不會上傳）"
}

# ---------- 6. GitHub ----------
Say "連接 GitHub（放網站用，手機才能練）"
gh auth status *> $null
$loggedIn = ($LASTEXITCODE -eq 0)
if (-not $loggedIn) {
  Write-Host "   接下來會打開瀏覽器請你登入 GitHub，照著畫面做就好。"
  Write-Host "   問你選項時：Account 選 GitHub.com，Protocol 選 HTTPS，都按 Enter 即可。" -ForegroundColor Yellow
  gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { Die "GitHub 登入沒完成。再執行一次 install.bat，它會從這一步繼續。" }
}
$me = (gh api user --jq .login 2>$null | Out-String).Trim()
if (-not $me) {
  Die "GitHub 登入沒有完成。請在命令提示字元執行： gh auth login --hostname github.com --git-protocol https --web
    登入完成後再跑一次 install.bat（前面做過的都會跳過）。"
}
OK "已登入為 $me"

# ---------- 7. 建 repo ----------
Say "建立網站的存放位置"
$repo = 'english-practice'
if (-not (Test-Path (Join-Path $root '.git'))) {
  git init -q
  git branch -M main
}
git add -A 2>$null | Out-Null
$hasCommit = (git rev-parse --verify HEAD 2>$null)
if (-not $hasCommit) {
  git -c user.name="$me" -c user.email="$me@users.noreply.github.com" commit -q -m "初始版本"
}
gh repo view "$me/$repo" *> $null
$repoMissing = ($LASTEXITCODE -ne 0)
if ($repoMissing) {
  Write-Host "   建立 $me/$repo …"
  Write-Host "   注意：這個 repo 是公開的（免費帳號的網站功能只支援公開），但裡面的講義和音檔都是加密的。" -ForegroundColor Yellow
  gh repo create $repo --public --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { Die "建立 repo 失敗。如果訊息說名稱已存在，把 setup.ps1 裡的 `$repo 改成別的名字再跑。" }
} else {
  OK "repo 已存在"
  $remote = git remote 2>$null
  if (-not $remote) { git remote add origin "https://github.com/$me/$repo.git" }
  git push -u origin main 2>$null | Out-Null
}
OK "程式已上傳"

# ---------- 8. 開網站 ----------
Say "啟用網站"
gh api "repos/$me/$repo/pages" *> $null
$pagesOff = ($LASTEXITCODE -ne 0)
if ($pagesOff) {
  gh api -X POST "repos/$me/$repo/pages" -f "source[branch]=main" -f "source[path]=/docs" *> $null
  if ($LASTEXITCODE -ne 0) {
    Warn "自動啟用失敗，請手動開一次："
    Write-Host "     到 https://github.com/$me/$repo/settings/pages"
    Write-Host "     Source 選 Deploy from a branch，branch 選 main，資料夾選 /docs，按 Save"
  } else { OK "網站已啟用" }
} else { OK "網站已經是啟用狀態" }
$siteUrl = "https://$me.github.io/$repo/"

# ---------- 9. 手機提醒 ----------
Say "手機提醒（可略過）"
Write-Host "   手機裝 ntfy app，訂閱一個只有你知道的名字，例如 kv-eng-8fq3x"
$topic = Read-Host "   輸入那個名字（直接按 Enter 可略過）"
if ($topic) {
  gh secret set NTFY_TOPIC --body $topic --repo "$me/$repo" 2>$null | Out-Null
  gh variable set SITE_URL --body $siteUrl --repo "$me/$repo" 2>$null | Out-Null
  OK "每天中午 12:30 會推播提醒"
} else {
  Warn "略過。之後想加就再跑一次 install.bat"
}

# ---------- 完成 ----------
Write-Host ""
Write-Host "安裝完成" -ForegroundColor Green
Write-Host ""
Write-Host "你的練習站網址（電腦和手機都用這個）："
Write-Host "   $siteUrl" -ForegroundColor White
Write-Host ""
Write-Host "接下來："
Write-Host "   1. 把講義（.docx）和上課錄音放進 inbox 資料夾"
Write-Host "   2. 雙擊「add-lesson.bat」"
Write-Host "   3. 跑完打開上面的網址，輸入你剛設的密碼"
Write-Host ""
Write-Host "inbox 裡的講義和錄音永遠不會上傳，只有加密後的小音檔會。"
[System.IO.File]::WriteAllText((Join-Path $root 'site-url.txt'), $siteUrl, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $root 'python-path.txt'), ($PY.Exe + "`n" + ($PY.Pre -join ' ')), [System.Text.UTF8Encoding]::new($false))
