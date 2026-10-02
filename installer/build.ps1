# Builds dist\JARVIS-Setup.exe from this J.A.R.V.I.S. install.
#  * Files are taken ONLY from the allowlist below (never credentials, sessions, logs, models, browser profiles).
#  * C:\LLM paths become {{ROOT}} placeholders; the installer fills in the chosen folder.
#  * A secret scanner checks every staged file and stops the build on anything that looks like a key or token.
#  * -CertThumbprint <thumbprint>: sign the exe with a code-signing certificate from Cert:\CurrentUser\My.
#  * The offline bundle (official downloads + ready trees from this PC) is appended to the exe; -NoBundle skips it.
param([string]$CertThumbprint, [string]$TimestampServer = 'http://timestamp.digicert.com', [switch]$NoBundle)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Split-Path -Parent $here                       # C:\LLM
$build = Join-Path $here 'build'
$stage = Join-Path $build 'payload'
$dist = Join-Path $here 'dist'
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $dist | Out-Null
function Say($m) { Write-Host "[build] $m" }

# ------------------------------------------------------------------ allowlist: component -> source files
function Add([string]$component, [string]$rel, [string]$from = $null) {
  $s = if ($from) { $from } else { Join-Path $src $rel }
  if (-not (Test-Path -LiteralPath $s)) { throw "missing source: $s" }
  $d = Join-Path (Join-Path $stage $component) $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $d) | Out-Null
  Copy-Item -LiteralPath $s -Destination $d -Force
}
function AddGlob([string]$component, [string]$relDir, [string[]]$patterns, [switch]$Recurse) {
  $dir = Join-Path $src $relDir
  foreach ($p in $patterns) {
    foreach ($f in Get-ChildItem -LiteralPath $dir -Filter $p -File -Recurse:$Recurse) {
      Add $component ($f.FullName.Substring($src.Length + 1))
    }
  }
}
function Write-Staged([string]$component, [string]$rel, [string]$text) {
  $d = Join-Path (Join-Path $stage $component) $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $d) | Out-Null
  [IO.File]::WriteAllText($d, $text, (New-Object Text.UTF8Encoding $false))
}

Say 'core: launcher, docs'
foreach ($f in 'launcher\server.js', 'launcher\start.ps1', 'README.md') { Add core $f }
AddGlob core 'launcher\lib' '*.js'
AddGlob core 'launcher\ui' '*.html', '*.css', '*.js', '*.svg'
AddGlob core 'launcher\mods' '*.wh.cpp'
foreach ($f in 'win-style.ps1', 'make-win-icons.ps1', 'make-cursors.ps1', 'make-lockscreen.ps1', 'tray.ps1') { Add core "launcher\tools\$f" }
Add core 'launcher\icons\jarvis.ico'
AddGlob core 'launcher\icons\windows' '*.ico', 'strip.png'
AddGlob core 'launcher\icons\cursors' '*.cur', 'strip.png'
AddGlob core 'docs' '*.yaml', '*.md'

Say 'agent: presets, skills, profile, voice plugin (no credentials, sessions, storages)'
$home2 = 'agent\home'
Add agent "$home2\AGENTS.md"
Add agent "$home2\cordis.patch.yml"
AddGlob agent "$home2\.agent-presets\lite" '*.yml'
# Lite preset's MCP row runs on this PC's system Node.js; friends get the portable one.
$litePath = Join-Path $stage "agent\$home2\.agent-presets\lite\agent.cordis.yml"
[IO.File]::WriteAllText($litePath, [IO.File]::ReadAllText($litePath).Replace('C:\Program Files\nodejs\node.exe', '{{ROOT}}\runtime\node\node.exe'), (New-Object Text.UTF8Encoding $false))
Add agent "$home2\.agent-presets\full\preset.yml"
AddGlob agent "$home2\skills" '*' -Recurse
# No pnpm-lock.yaml: it stores the local plugin as a path relative to THIS machine's profile, which points
# elsewhere on another PC. package.json below pins exact versions instead.
foreach ($f in 'package.json', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml') { Add agent "$home2\profiles\web\$f" }
foreach ($f in 'package.json', 'cordis.patch.yml') { Add agent "agent\plugins\dsh-jarvis\$f" }
AddGlob agent 'agent\plugins\dsh-jarvis\lib' '*.js', '*.css'
Add agent 'agent\rules.yaml' 'C:\Projects\.dsh\rules.yaml'
# Agent runtime: lockfile of the tested dsh tree (with integrity), so `npm ci` can't pick up a newer release.
foreach ($f in 'package.json', 'package-lock.json') { Add agent "runtime\dsh\$f" (Join-Path $PSScriptRoot "dsh-runtime\$f") }

Say 'blender, capcut, hud'
foreach ($f in 'blender-mcp.cmd', 'start_mcp.py', 'install_addon.py', 'install-addon.cmd', 'blender_mcp_addon.py') { Add blender "tools\blender\$f" }
Add capcut 'tools\mcp\VectCutAPI\config.json'
Add capcut 'tools\mcp\VectCutAPI\mcp_server.py'
# Agent's image tool (ComfyUI); works once ComfyUI is installed from the launcher.
Add agent 'tools\mcp\comfyui\server.js'
# Telegram bot + the plugin that joins its ACP sessions to agent presets (token/config stay in data\, never shipped).
Add agent 'tools\telegram\bot.js'
Add agent 'agent\plugins\jarvis-acp-presets\index.mjs'
Add hud 'hud\JarvisHUD2.exe'
Add hud 'hud\jarvis2.ico'

# ------------------------------------------------------------------ generated / sanitized files
# Fresh agent settings: no personal defaults, onboarding state or keys. English by default; the launcher
# switches locale, the Russian UI plugin and the reply language to the one chosen in the installer.
Write-Staged agent "$home2\settings.yaml" @"
locale:
  preference: en
russian-lang:
  enabled: false
subagent-model-selection:
  enabled: true
  allowedModels:
    - provider: deepseek-official
      model: deepseek-v4-flash
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
"@

# Home patch: the local-models block is regenerated by the launcher from the friend's own models.
$patchPath = Join-Path $stage "agent\$home2\cordis.patch.yml"
$patch = [IO.File]::ReadAllText($patchPath)
$patch = [regex]::Replace($patch, '(?s)# >>> J\.A\.R\.V\.I\.S\. launcher.*?# <<< J\.A\.R\.V\.I\.S\. launcher',
  "# >>> J.A.R.V.I.S. launcher: local models (generated from models\registry.json, do not edit by hand)`n# (no local models installed)`n# <<< J.A.R.V.I.S. launcher")
[IO.File]::WriteAllText($patchPath, $patch, (New-Object Text.UTF8Encoding $false))

# Profile plugins: exact versions (the ones tested here) instead of ^ranges.
$pkgPath = Join-Path $stage "agent\$home2\profiles\web\package.json"
$pkg = [IO.File]::ReadAllText($pkgPath)
$pkg = [regex]::Replace($pkg, '("[\w@/.-]+":\s*")\^(\d[^"]*")', '$1$2')
[IO.File]::WriteAllText($pkgPath, $pkg, (New-Object Text.UTF8Encoding $false))

# AGENTS.md: environment line describing this PC -> generic.
$agentsPath = Join-Path $stage "agent\$home2\AGENTS.md"
$agents = [IO.File]::ReadAllText($agentsPath)
$agents = $agents -replace '(?m)^- Node\.js v24, Python 3\.14, Git установлены\.\r?$', '- Среда агента: портативные Node.js и Python внутри папки J.A.R.V.I.S.'
[IO.File]::WriteAllText($agentsPath, $agents, (New-Object Text.UTF8Encoding $false))

# Full preset -> _base.yml + one _mcp\<name>.yml per MCP row (the installer keeps only installed tools).
$full = [IO.File]::ReadAllText((Join-Path $src "$home2\.agent-presets\full\agent.cordis.yml")) -replace "`r`n", "`n"
$lines = $full -split "`n"
$mcpStart = [Array]::FindIndex($lines, [Predicate[string]] { param($l) $l -match '^# ── MCP servers' })
if ($mcpStart -lt 0) { throw 'MCP section not found in the full preset' }
$firstRow = [Array]::FindIndex($lines, $mcpStart, [Predicate[string]] { param($l) $l -match '^- id: mcp-' })
# Comments directly above the first row belong to it, the section header stays in the base.
$cut = $firstRow; while ($cut -gt $mcpStart -and $lines[$cut - 1] -match '^#' -and $lines[$cut - 1] -notmatch '^# ── ') { $cut-- }
Write-Staged agent "$home2\.agent-presets\full\_base.yml" (($lines[0..($cut - 1)] -join "`n") + "`n")
$chunks = @{}; $name = $null; $buf = New-Object System.Collections.Generic.List[string]; $pending = New-Object System.Collections.Generic.List[string]
for ($i = $cut; $i -lt $lines.Count; $i++) {
  $l = $lines[$i]
  if ($l -match '^- id: mcp-([\w-]+)') {
    if ($name) { $chunks[$name] = ($buf -join "`n").TrimEnd() + "`n" }
    $name = $Matches[1]; $buf = New-Object System.Collections.Generic.List[string]
    $buf.AddRange($pending); $pending.Clear(); $buf.Add($l)
  } elseif ($l -match '^#') { $pending.Add($l) }
  else { if ($name) { $buf.AddRange($pending); $pending.Clear(); $buf.Add($l) } }
}
if ($name) { $chunks[$name] = ($buf -join "`n").TrimEnd() + "`n" }
foreach ($k in $chunks.Keys) {
  $text = $chunks[$k] -replace "'--browser', 'chrome'", "'--browser', '{{BROWSER}}'"
  # This PC runs MCP tools on the system Node.js; friends get the portable one inside the install folder.
  $text = $text.Replace('C:\Program Files\nodejs\node.exe', '{{ROOT}}\runtime\node\node.exe')
  Write-Staged agent "$home2\.agent-presets\full\_mcp\$k.yml" $text
}
Say ("full preset: base + MCP rows: " + (($chunks.Keys | Sort-Object) -join ', '))

# ------------------------------------------------------------------ templating: C:\LLM -> {{ROOT}}
$textExt = '.yml', '.yaml', '.json', '.js', '.md', '.ps1', '.cmd', '.txt', '.css', '.html', '.py', '.cpp'
foreach ($f in Get-ChildItem $stage -Recurse -File | Where-Object { $textExt -contains $_.Extension.ToLower() }) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $t = (New-Object Text.UTF8Encoding $false).GetString($bytes, [int]$bom * 3, $bytes.Length - [int]$bom * 3)
  $n = $t.Replace('C:\\LLM', '{{ROOT_JS}}').Replace('C:/LLM', '{{ROOT_FWD}}').Replace('C:\LLM', '{{ROOT}}')
  if ($n -ne $t) { [IO.File]::WriteAllText($f.FullName, $n, (New-Object Text.UTF8Encoding $bom)) }
}

# Compiled HUD: Rust keeps build paths like C:\Users\<name>\.cargo\... in panic messages.
# Replace the user name with a same-length placeholder so the binary layout does not change.
$exe = Join-Path $stage 'hud\hud\JarvisHUD2.exe'
$user = $env:USERNAME
$bytesExe = [IO.File]::ReadAllBytes($exe)
$latin = [Text.Encoding]::GetEncoding(28591)
$textExe = $latin.GetString($bytesExe)
$fake = ('u' * $user.Length)
foreach ($sep in '\', '/', '\\') {
  $textExe = [regex]::Replace($textExe, [regex]::Escape("Users$sep$user"), "Users$sep$fake", 'IgnoreCase')
}
[IO.File]::WriteAllBytes($exe, $latin.GetBytes($textExe))

# ------------------------------------------------------------------ secret scanner
Say 'scanning for secrets'
$forbiddenNames = '(?i)(^\.credentials|\.env$|\.pem$|\.key$|^id_rsa|^url\.txt$|\.log$|^\.anonymous-user-id$|registry\.json$|backup\.json$)'
$forbiddenDirs = '(?i)\\(sessions|storages|node_modules|edge-profile|\.venv|models|windhawk)\\'
$patterns = [ordered]@{
  'OpenAI/DeepSeek-style key' = 'sk-[A-Za-z0-9_\-]{16,}'
  'Anthropic key/token'       = 'sk-ant-[A-Za-z0-9_\-]{10,}'
  'URL token'                 = 'token=[A-Za-z0-9_\-]{16,}'
  'API key assignment'        = '(?i)api[_-]?key["'']?\s*[:=]\s*["'']?[A-Za-z0-9_\-]{20,}'
  'GitHub token'              = 'gh[pousr]_[A-Za-z0-9]{20,}'
  'Hugging Face token'        = 'hf_[A-Za-z0-9]{20,}'
  'AWS key'                   = 'AKIA[0-9A-Z]{16}'
  'Google API key'            = 'AIza[0-9A-Za-z_\-]{30,}'
  'Slack token'               = 'xox[baprs]-[A-Za-z0-9\-]{10,}'
  'Telegram bot token'        = '\b\d{6,12}:AA[A-Za-z0-9_\-]{30,}'
  'Private key'               = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'Bearer token'              = '(?i)bearer\s+[A-Za-z0-9_\-\.]{24,}'
  'Personal path'             = ('(?i)Users[\\/]+' + [regex]::Escape($env:USERNAME) + '\b')
}
# Known public values that only look like keys (checked by hand):
#  - BlenderMCP addon: RODIN_FREE_TRIAL_KEY = "vibecoding", the public Hyper3D trial key shipped by upstream.
$allowed = @('api_key = RODIN_FREE_TRIAL_KEY')
$problems = @()
foreach ($f in Get-ChildItem $stage -Recurse -File -Force) {
  $rel = $f.FullName.Substring($stage.Length)
  if ($f.Name -match $forbiddenNames) { $problems += "forbidden file: $rel" }
  if ($rel -match $forbiddenDirs) { $problems += "forbidden folder: $rel" }
  $text = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($f.FullName))
  foreach ($k in $patterns.Keys) {
    foreach ($m in [regex]::Matches($text, $patterns[$k])) {
      if ($allowed | Where-Object { $m.Value.StartsWith($_) }) { continue }
      $problems += "$k in ${rel}: " + $m.Value.Substring(0, [Math]::Min(12, $m.Value.Length)) + '…'
      break
    }
  }
}
if ($problems.Count) { $problems | ForEach-Object { Write-Host "  ✖ $_" -ForegroundColor Red }; throw "secret scan failed ($($problems.Count)) — nothing was built" }
Say ("secret scan clean: " + (Get-ChildItem $stage -Recurse -File).Count + ' files')

# ------------------------------------------------------------------ payload + compile
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$payload = Join-Path $build 'payload.zip'
# Entries with '/' separators (ZipFile.CreateFromDirectory in PowerShell 5.1 writes '\').
$zs = [IO.File]::Create($payload)
$za = New-Object IO.Compression.ZipArchive($zs, [IO.Compression.ZipArchiveMode]::Create)
foreach ($f in Get-ChildItem $stage -Recurse -File -Force) {
  $name = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
}
$za.Dispose(); $zs.Dispose()
Say ('payload.zip: {0:N1} MB' -f ((Get-Item $payload).Length / 1MB))

Copy-Item (Join-Path $here 'ui.xaml') (Join-Path $build 'ui.xaml')
@'
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="JARVIS.Setup"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
  </windowsSettings></application>
</assembly>
'@ | Set-Content (Join-Path $build 'app.manifest') -Encoding UTF8

$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $fw 'csc.exe'
$refs = @("$fw\WPF\PresentationFramework.dll", "$fw\WPF\PresentationCore.dll", "$fw\WPF\WindowsBase.dll", "$fw\System.Xaml.dll",
  "$fw\System.IO.Compression.dll", "$fw\System.IO.Compression.FileSystem.dll", "$fw\System.Management.dll",
  "$fw\Microsoft.CSharp.dll", "$fw\System.Core.dll", "$fw\System.Windows.Forms.dll", "$fw\System.Drawing.dll", "$fw\System.dll") |
  ForEach-Object { "/r:$_" }
$out = Join-Path $dist 'JARVIS-Setup.exe'
Push-Location $build
& $csc /nologo /target:winexe /optimize+ "/out:$out" "/win32icon:$src\launcher\icons\jarvis.ico" /win32manifest:app.manifest `
  /resource:payload.zip,payload.zip /resource:ui.xaml,ui.xaml @refs (Join-Path $here 'Installer.cs')
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "csc failed ($code)" }

# ------------------------------------------------------------------ offline bundle (appended to the exe)
if (-not $NoBundle) {
  $cache = Join-Path $here 'cache'
  New-Item -ItemType Directory -Force -Path "$cache\dl", "$cache\vendor" | Out-Null

  # Official archives, pinned exactly as in Installer.cs (Src) and verified by SHA-256.
  $cs = [IO.File]::ReadAllText((Join-Path $here 'Installer.cs'))
  $srcConst = @{}
  foreach ($m in [regex]::Matches($cs, 'public const string (\w+) = "([^"]*)";')) { $srcConst[$m.Groups[1].Value] = $m.Groups[2].Value }
  $official = @(
    @{ url = $srcConst.NodeUrl; sha = $srcConst.NodeSha },
    @{ url = $srcConst.UvUrl; sha = $srcConst.UvSha },
    @{ url = $srcConst.LlamaBase + $srcConst.LlamaCuda; sha = $srcConst.LlamaCudaSha },
    @{ url = $srcConst.LlamaBase + $srcConst.CudaRt; sha = $srcConst.CudaRtSha },
    @{ url = $srcConst.LlamaBase + $srcConst.LlamaVulkan; sha = $srcConst.LlamaVulkanSha },
    @{ url = $srcConst.LlamaBase + $srcConst.LlamaCpu; sha = $srcConst.LlamaCpuSha },
    @{ url = $srcConst.VectCutUrl; sha = $srcConst.VectCutSha; name = 'vectcut.zip' }
  )
  $blobs = New-Object System.Collections.Generic.List[object]
  foreach ($o in $official) {
    $name = if ($o.name) { $o.name } else { $o.url.Substring($o.url.LastIndexOf('/') + 1) }
    $file = Join-Path "$cache\dl" $name
    if (-not (Test-Path $file) -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $o.sha) {
      Say "download $name"
      $ok = $false
      for ($try = 1; $try -le 4 -and -not $ok; $try++) {
        # curl writes progress/errors to stderr: keep PowerShell from turning that into a terminating error.
        $ErrorActionPreference = 'Continue'
        & "$env:SystemRoot\System32\curl.exe" -L --fail -s -S --retry 5 --retry-all-errors -o "$file.part" $o.url 2>&1 | ForEach-Object { Say "  curl: $_" }
        $ok = $LASTEXITCODE -eq 0
        $ErrorActionPreference = 'Stop'
        if (-not $ok) { Say "  retry $try"; Start-Sleep 10 }
      }
      if (-not $ok) { throw "download failed: $($o.url)" }
      if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash.ToLower() -ne $o.sha) { Remove-Item "$file.part"; throw "SHA-256 mismatch: $name" }
      Move-Item "$file.part" $file -Force
    }
    $blobs.Add(@{ name = $name; file = $file; sha = $o.sha })
  }

  # Ready trees from this PC. Excluded: pnpm/uv state with this PC's paths, uv's per-machine
  # environments, Windhawk's user profile, anything the installer recreates.
  $vendors = [ordered]@{
    'vendor-dsh.zip'        = @{ dir = "$src\runtime\dsh"; exclude = '^package(-lock)?\.json$|(^|/)\.cache/' }
    'vendor-profile.zip'    = @{ dir = "$src\agent\home\profiles\web\node_modules"; exclude = '^\.bin/|^\.modules\.yaml$|^\.pnpm-workspace-state|^\.pnpm/|^dsh-jarvis(/|$)|(^|/)\.cache/' }
    'vendor-uv.zip'         = @{ dir = "$src\runtime\uv"; exclude = '^(uv|uvx|uvw)\.exe$|^tools/|^cache/(environments|interpreter|builds)-v\d+/|^python/\.temp/|(^|/)\.lock$' }
    'vendor-playwright.zip' = @{ dir = "$src\tools\mcp\playwright"; exclude = '' }
    'vendor-windhawk.zip'   = @{ dir = "$src\tools\windhawk"; exclude = '^AppData/(userprofile\.json|Engine/ModsWritable/|Engine/Symbols/)' }
  }

  # Needles: this PC's real secret values (read locally, never printed or stored) and profile path.
  $needles = New-Object System.Collections.Generic.List[byte[]]
  $ignoreCase = New-Object System.Collections.Generic.List[bool]
  $labels = New-Object System.Collections.Generic.List[string]
  $secretValues = New-Object System.Collections.Generic.HashSet[string]
  foreach ($credFile in @("$src\agent\home\.credentials.yaml", "$src\data\telegram\config.json")) {
    if (Test-Path $credFile) { foreach ($m in [regex]::Matches([IO.File]::ReadAllText($credFile), '[A-Za-z0-9_\-\.]{20,}')) { [void]$secretValues.Add($m.Value) } }
  }
  $userEnv = [Environment]::GetEnvironmentVariables('User')
  foreach ($k in $userEnv.Keys) { if ($k -match '(?i)key|token|secret|pass' -and "$($userEnv[$k])".Length -ge 12) { [void]$secretValues.Add("$($userEnv[$k])") } }
  $i = 0
  foreach ($v in $secretValues) {
    $i++
    foreach ($enc in [Text.Encoding]::ASCII, [Text.Encoding]::Unicode) { $needles.Add($enc.GetBytes($v)); $ignoreCase.Add($false); $labels.Add("значение ключа №$i") }
  }
  foreach ($p in "Users\$env:USERNAME\", "Users/$env:USERNAME/", "Users\\$env:USERNAME\\") {
    foreach ($enc in [Text.Encoding]::ASCII, [Text.Encoding]::Unicode) { $needles.Add($enc.GetBytes($p)); $ignoreCase.Add($true); $labels.Add('личный путь (Users\<имя>)') }
  }
  $needleText = ($needles | ForEach-Object { [Convert]::ToBase64String($_) }) -join ','
  $needleHash = [BitConverter]::ToString((New-Object Security.Cryptography.SHA256Managed).ComputeHash([Text.Encoding]::UTF8.GetBytes($needleText))).Replace('-', '')
  Say "secret values checked in vendor trees: $($secretValues.Count)"

  Add-Type -Path (Join-Path $here 'tools\VendorPack.cs') -ReferencedAssemblies System.IO.Compression, System.IO.Compression.FileSystem
  $vendorProblems = @()
  foreach ($name in $vendors.Keys) {
    $v = $vendors[$name]
    $zip = Join-Path "$cache\vendor" $name
    $key = [VendorPack]::Fingerprint($v.dir, $v.exclude) + '|' + $v.exclude + '|' + $needleHash
    $keyFile = "$zip.key"
    if ((Test-Path $zip) -and (Test-Path $keyFile) -and ([IO.File]::ReadAllText($keyFile) -eq $key)) { Say "${name}: unchanged (cache)" }
    else {
      Say "pack $name ($($v.dir))"
      Remove-Item $zip, $keyFile -ErrorAction SilentlyContinue
      $hits = [VendorPack]::Pack($v.dir, $zip, $v.exclude, $needles.ToArray(), $ignoreCase.ToArray(), $labels.ToArray())
      if ($hits.Count) { Remove-Item $zip; $vendorProblems += $hits | ForEach-Object { "${name}: $_" } }
      else { [IO.File]::WriteAllText($keyFile, $key) }
    }
    if (Test-Path $zip) { $blobs.Add(@{ name = $name; file = $zip; sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() }) }
  }
  if ($vendorProblems.Count) { $vendorProblems | Select-Object -First 40 | ForEach-Object { Write-Host "  ✖ $_" -ForegroundColor Red }; Remove-Item $out; throw "vendor scan failed ($($vendorProblems.Count)) — nothing was built" }

  # [exe][blobs][index][int64 index length]["JRVSPACK"]
  $fs = [IO.File]::Open($out, 'Append', 'Write')
  $index = New-Object Text.StringBuilder
  foreach ($b in $blobs) {
    $offset = $fs.Position
    $in = [IO.File]::OpenRead($b.file); $in.CopyTo($fs, 1MB); $in.Dispose()
    [void]$index.Append("$($b.name)|$offset|$($fs.Position - $offset)|$($b.sha)`n")
  }
  $ib = [Text.Encoding]::UTF8.GetBytes($index.ToString())
  $fs.Write($ib, 0, $ib.Length)
  $lb = [BitConverter]::GetBytes([long]$ib.Length); $fs.Write($lb, 0, 8)
  $mb = [Text.Encoding]::ASCII.GetBytes('JRVSPACK'); $fs.Write($mb, 0, 8)
  $fs.Dispose()
  foreach ($b in $blobs) { Say ('  {0,-48} {1,8:N0} MB' -f $b.name, ((Get-Item $b.file).Length / 1MB)) }
}

if ($CertThumbprint) {
  $cert = Get-Item "Cert:\CurrentUser\My\$CertThumbprint"
  $sig = Set-AuthenticodeSignature -FilePath $out -Certificate $cert -TimestampServer $TimestampServer -HashAlgorithm SHA256
  Say "signature: $($sig.Status)"
} else { Say 'not signed (pass -CertThumbprint to sign)' }
Say ('{0} · {1:N1} MB · SHA-256 {2}' -f $out, ((Get-Item $out).Length / 1MB), (Get-FileHash $out -Algorithm SHA256).Hash.ToLower())
