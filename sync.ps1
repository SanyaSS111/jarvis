# J.A.R.V.I.S.: sources between the working install (C:\LLM) and this git repository.
#   .\sync.ps1            C:\LLM -> repo: copy the allowlisted sources here, then `git status` / commit.
#   .\sync.ps1 -ToLive    repo -> C:\LLM: put the repo's version back into the working install (rollback).
# Only files from the allowlist below are touched: never keys, sessions, logs, models or downloaded programs.
# Every file going into the repo is checked for this PC's real secret values, key/token patterns and the
# user-profile path; any hit stops the sync and nothing is copied.
param([switch]$ToLive, [string]$Live = 'C:\LLM')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

# ------------------------------------------------------------------ allowlist (paths relative to C:\LLM)
$files = @(
  'README.md',
  'launcher\server.js', 'launcher\start.ps1',
  'launcher\lib\*.js', 'launcher\ui\*.html', 'launcher\ui\*.css', 'launcher\ui\*.js', 'launcher\ui\*.svg',
  'launcher\mods\*.wh.cpp', 'launcher\tools\*.ps1', 'launcher\icons\**',
  'agent\plugins\dsh-jarvis\package.json', 'agent\plugins\dsh-jarvis\cordis.patch.yml', 'agent\plugins\dsh-jarvis\lib\**',
  'agent\plugins\jarvis-acp-presets\index.mjs',
  'agent\home\AGENTS.md', 'agent\home\cordis.patch.yml', 'agent\home\.agent-presets\**', 'agent\home\skills\**',
  'agent\home\profiles\web\package.json', 'agent\home\profiles\web\cordis.patch.yml', 'agent\home\profiles\web\cordis.yml',
  'agent\home\profiles\web\pnpm-workspace.yaml',
  'tools\mcp\comfyui\server.js', 'tools\telegram\bot.js',
  'tools\blender\blender-mcp.cmd', 'tools\blender\start_mcp.py', 'tools\blender\install_addon.py', 'tools\blender\install-addon.cmd',
  'tools\blender\blender_mcp_addon.py', 'tools\mcp\VectCutAPI\config.json', 'tools\mcp\VectCutAPI\mcp_server.py',
  'installer\Installer.cs', 'installer\ui.xaml', 'installer\build.ps1', 'installer\tools\**',
  'installer\dsh-runtime\package.json', 'installer\dsh-runtime\package-lock.json',
  'docs\*.yaml', 'docs\*.md',
  'hud\src\**', 'hud\tools\**', 'hud\Cargo.toml', 'hud\Cargo.lock', 'hud\build.bat', 'hud\jarvis2.ico'
)
# Outside C:\LLM: the agent's access rules (repo path => live path).
$extra = @{ 'agent\rules.yaml' = 'C:\Projects\.dsh\rules.yaml' }
# Folders this script owns in the repo (files there that are no longer in the allowlist get removed).
$managed = 'launcher', 'agent', 'tools', 'installer', 'docs', 'hud'

function Expand([string]$base, [string]$pattern) {
  if ($pattern.EndsWith('\**')) {
    $dir = Join-Path $base $pattern.Substring(0, $pattern.Length - 3)
    if (Test-Path $dir) { Get-ChildItem $dir -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($base.Length + 1) } }
  } else {
    $dir = Split-Path (Join-Path $base $pattern); $leaf = Split-Path $pattern -Leaf
    if (Test-Path $dir) { Get-ChildItem $dir -Filter $leaf -File -Force | ForEach-Object { $_.FullName.Substring($base.Length + 1) } }
  }
}

# The launcher rewrites this block from the installed models: in the repo it stays empty.
$block = '(?s)# >>> J\.A\.R\.V\.I\.S\. launcher.*?# <<< J\.A\.R\.V\.I\.S\. launcher'
$emptyBlock = "# >>> J.A.R.V.I.S. launcher: local models (generated from models\registry.json, do not edit by hand)`n# (no local models installed)`n# <<< J.A.R.V.I.S. launcher"

# ------------------------------------------------------------------ repo -> live
if ($ToLive) {
  $n = 0
  foreach ($p in $files) {
    foreach ($rel in Expand $repo $p) {
      $src = Join-Path $repo $rel; $dst = Join-Path $Live $rel
      New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
      if ($rel -eq 'agent\home\cordis.patch.yml' -and (Test-Path $dst)) {
        # Keep the live list of local models.
        $liveBlock = [regex]::Match([IO.File]::ReadAllText($dst), $block).Value
        $text = [IO.File]::ReadAllText($src)
        if ($liveBlock) { $text = [regex]::Replace($text, $block, { param($m) $liveBlock }) }
        [IO.File]::WriteAllText($dst, $text, (New-Object Text.UTF8Encoding $false))
      } else { Copy-Item -LiteralPath $src -Destination $dst -Force }
      $n++
    }
  }
  foreach ($k in $extra.Keys) { if (Test-Path (Join-Path $repo $k)) { Copy-Item (Join-Path $repo $k) $extra[$k] -Force; $n++ } }
  Write-Host "Возвращено в $Live файлов: $n. Перезапустите лаунчер и агента." -ForegroundColor Cyan
  return
}

# ------------------------------------------------------------------ live -> repo
$plan = [ordered]@{} # repo relative path -> live full path
foreach ($p in $files) { foreach ($rel in Expand $Live $p) { $plan[$rel] = Join-Path $Live $rel } }
foreach ($k in $extra.Keys) { if (Test-Path $extra[$k]) { $plan[$k] = $extra[$k] } }

# Secret scan before anything is written.
$needles = New-Object System.Collections.Generic.List[string]
foreach ($f in "$Live\agent\home\.credentials.yaml", "$Live\data\telegram\config.json") {
  if (Test-Path $f) { foreach ($m in [regex]::Matches([IO.File]::ReadAllText($f), '[A-Za-z0-9_\-\.]{20,}')) { $needles.Add($m.Value) } }
}
$userEnv = [Environment]::GetEnvironmentVariables('User')
foreach ($k in $userEnv.Keys) { if ($k -match '(?i)key|token|secret|pass' -and "$($userEnv[$k])".Length -ge 12) { $needles.Add("$($userEnv[$k])") } }
$patterns = [ordered]@{
  'ключ OpenAI/DeepSeek' = 'sk-[A-Za-z0-9_\-]{16,}'
  'токен в URL'           = 'token=[A-Za-z0-9_\-]{16,}'
  'ключ API'              = '(?i)api[_-]?key["'']?\s*[:=]\s*["'']?[A-Za-z0-9_\-]{20,}'
  'токен GitHub'          = 'gh[pousr]_[A-Za-z0-9]{20,}'
  'токен Hugging Face'    = 'hf_[A-Za-z0-9]{20,}'
  'токен Telegram-бота'   = '\b\d{6,12}:AA[A-Za-z0-9_\-]{30,}'
  'закрытый ключ'         = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'личный путь'           = ('(?i)Users[\\/]+' + [regex]::Escape($env:USERNAME) + '\b')
}
$allowed = @('api_key = RODIN_FREE_TRIAL_KEY') # public Hyper3D trial key shipped by BlenderMCP upstream
$problems = @()
$latin = [Text.Encoding]::GetEncoding(28591)
foreach ($rel in $plan.Keys) {
  $bytes = [IO.File]::ReadAllBytes($plan[$rel])
  if ($bytes.Length -gt 5MB) { $problems += "слишком большой файл (${rel}: $([math]::Round($bytes.Length / 1MB)) МБ)"; continue }
  $text = $latin.GetString($bytes)
  $utf8 = [Text.Encoding]::UTF8.GetString($bytes)
  $i = 0
  foreach ($v in $needles) { $i++; if ($utf8.Contains($v)) { $problems += "значение ключа №$i в $rel" } }
  foreach ($k in $patterns.Keys) {
    foreach ($m in [regex]::Matches($text, $patterns[$k])) {
      if ($allowed | Where-Object { $m.Value.StartsWith($_) }) { continue }
      $problems += "$k в $rel"; break
    }
  }
}
if ($problems.Count) {
  $problems | Select-Object -Unique | ForEach-Object { Write-Host "  ✖ $_" -ForegroundColor Red }
  throw "Проверка не пройдена ($($problems.Count)) — в репозиторий ничего не скопировано."
}

$n = 0
foreach ($rel in $plan.Keys) {
  $dst = Join-Path $repo $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  if ($rel -eq 'agent\home\cordis.patch.yml') {
    $text = [regex]::Replace([IO.File]::ReadAllText($plan[$rel]), $block, $emptyBlock)
    [IO.File]::WriteAllText($dst, $text, (New-Object Text.UTF8Encoding $false))
  } else { Copy-Item -LiteralPath $plan[$rel] -Destination $dst -Force }
  $n++
}
# Files that left the allowlist or were deleted in C:\LLM (git keeps their history).
$removed = 0
foreach ($m in $managed) {
  $d = Join-Path $repo $m
  if (-not (Test-Path $d)) { continue }
  foreach ($f in Get-ChildItem $d -Recurse -File -Force) {
    $rel = $f.FullName.Substring($repo.Length + 1)
    if (-not $plan.Contains($rel)) { Remove-Item -LiteralPath $f.FullName -Force; $removed++ }
  }
}
Write-Host "Скопировано файлов: $n, убрано устаревших: $removed. Проверка на ключи и личные пути пройдена." -ForegroundColor Cyan
if (Test-Path (Join-Path $repo '.git')) { git -C $repo status --short }
