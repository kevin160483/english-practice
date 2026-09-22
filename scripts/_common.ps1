# 共用：找出「真的」Python。Windows 的 python 指令常常是微軟商店的假捷徑，
# 所以這裡不只看指令存不存在，而是實際執行一次確認它會回答。

function Test-RealPython($exe, $pre) {
  try {
    $out = & $exe @($pre + @('-c', 'import sys;print(sys.version_info.major)')) 2>$null
    return ($LASTEXITCODE -eq 0 -and "$out".Trim() -eq '3')
  } catch { return $false }
}

function Resolve-Python {
  $cands = @()

  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { $cands += @{ Exe = 'py'; Pre = @('-3') } }

  foreach ($c in @(Get-Command python -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -and $c.Source -notmatch 'WindowsApps') { $cands += @{ Exe = $c.Source; Pre = @() } }
  }

  foreach ($dir in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python311",
                     "$env:ProgramFiles\Python312", "$env:ProgramFiles\Python313", "C:\Python312", "C:\Python311")) {
    if (Test-Path $dir) {
      foreach ($f in Get-ChildItem -Path $dir -Filter python.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue) {
        $cands += @{ Exe = $f.FullName; Pre = @() }
      }
    }
  }

  foreach ($c in $cands) {
    if (Test-RealPython $c.Exe $c.Pre) { return $c }
  }
  return $null
}

function Invoke-Py($py, $arguments) {
  & $py.Exe @($py.Pre + $arguments)
}
