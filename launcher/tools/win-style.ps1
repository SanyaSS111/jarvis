# J.A.R.V.I.S. look for Windows icons: apply / restore / status. Called by the launcher; prints JSON.
# Changes only per-user things, and backs up every original value before touching it:
#  - desktop icons (This PC, user folder, Network, Control Panel, Recycle Bin) via HKCU ...\Explorer\CLSID\{id}\DefaultIcon
#  - icons of the user folders (Documents, Downloads, Pictures, Music, Videos, Desktop) via their desktop.ini
#  - icons of shortcuts of known apps on the Desktop and pinned to the taskbar (unknown shortcuts stay as they are)
param([ValidateSet('apply', 'restore', 'status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'

$launcher = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $launcher
$iconDir = Join-Path $launcher 'icons\windows'
$backupFile = Join-Path $root 'data\launcher\win-style-backup.json'
function Ico([string]$name) { Join-Path $iconDir "$name.ico" }

$clsidBase = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID'
$clsids = @(
  @{ id = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'; icon = 'this-pc' },
  @{ id = '{59031a47-3f72-44a7-89c5-5595fe6b30ee}'; icon = 'user' },
  @{ id = '{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}'; icon = 'network' },
  @{ id = '{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}'; icon = 'control' },
  @{ id = '{645FF040-5081-101B-9F08-00AA002F954E}'; icon = 'recycle-empty'; full = 'recycle-full' }
)
$folders = [ordered]@{ documents = 'shell:Personal'; downloads = 'shell:Downloads'; pictures = 'shell:My Pictures';
  music = 'shell:My Music'; videos = 'shell:My Video'; desktop = 'shell:Desktop' }

# Which Jarvis icon a shortcut gets (by target, arguments or name); $null = leave it alone.
function Match-Shortcut($target, $arguments, $name) {
  $all = "$target $arguments $name"
  if ($all -match 'launcher\\start\.ps1') { return $null }                 # J.A.R.V.I.S. keeps its own icon
  if ($all -match 'telegram') { return 'telegram' }
  if ($all -match 'discord') { return 'discord' }
  if ($all -match 'torrent|btweb') { return 'torrent' }
  if ($all -match 'capcut') { return 'capcut' }
  if ($all -match 'blender') { return 'blender' }
  if ($name -match 'видео|video') { return 'video-dl' }
  if ($target -match '\\(chrome|msedge|firefox|opera|brave|browser|vivaldi)\.exe$') { return 'browser' }
  if ($target -match '\\explorer\.exe$') { return 'folder' }
  return $null
}

function Load-Backup {
  if (Test-Path $backupFile) { return Get-Content $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  return $null
}

function Read-Ini([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $enc = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [Text.Encoding]::Unicode }
    elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB) { New-Object Text.UTF8Encoding $true }
    else { [Text.Encoding]::Default }
  return @{ text = $enc.GetString($bytes).TrimStart([char]0xFEFF); enc = $enc; bytes = $bytes }
}

function Set-IniIcon([string]$dir, [string]$iconPath) {
  $ini = Join-Path $dir 'desktop.ini'
  if (Test-Path -LiteralPath $ini) { $r = Read-Ini $ini; $text = $r.text; $enc = $r.enc }
  else { $text = ''; $enc = [Text.Encoding]::Unicode }
  $lines = [Collections.Generic.List[string]]($text -split "`r?`n")
  $sec = $lines.FindIndex([Predicate[string]] { param($l) $l.Trim() -ieq '[.ShellClassInfo]' })
  if ($sec -lt 0) { $lines.Insert(0, '[.ShellClassInfo]'); $sec = 0 }
  $end = $lines.FindIndex($sec + 1, [Predicate[string]] { param($l) $l.Trim().StartsWith('[') })
  if ($end -lt 0) { $end = $lines.Count }
  $found = $false
  for ($i = $sec + 1; $i -lt $end; $i++) {
    if ($lines[$i] -match '^\s*IconResource\s*=') { $lines[$i] = "IconResource=$iconPath,0"; $found = $true }
  }
  if (-not $found) { $lines.Insert($sec + 1, "IconResource=$iconPath,0") }
  if (Test-Path -LiteralPath $ini) { [IO.File]::SetAttributes($ini, 'Normal') }
  [IO.File]::WriteAllText($ini, (($lines | Where-Object { $_ -ne $null }) -join "`r`n").TrimEnd() + "`r`n", $enc)
  [IO.File]::SetAttributes($ini, 'Hidden, System')
  # Explorer only reads desktop.ini in folders marked read-only or system.
  $d = Get-Item -LiteralPath $dir -Force
  if (-not ($d.Attributes -band [IO.FileAttributes]::ReadOnly)) { $d.Attributes = $d.Attributes -bor [IO.FileAttributes]::ReadOnly }
}

function Shortcut-Dirs {
  @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')) |
    Where-Object { Test-Path -LiteralPath $_ }
}

function Refresh-Icons {
  try { Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -WindowStyle Hidden -Wait } catch {}
  # Ask Explorer to re-read icons of everything that changed.
  Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, System.IntPtr a, System.IntPtr b);' -ErrorAction SilentlyContinue
  [Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

# ------------------------------------------------------------------ apply
function Do-Apply {
  $old = Load-Backup
  $backup = if ($old) { $old } else { [pscustomobject]@{ created = (Get-Date).ToString('s'); clsid = @(); folders = @(); shortcuts = @() } }
  $done = @{ clsid = 0; folders = 0; shortcuts = 0; errors = @() }

  foreach ($c in $clsids) {
    try {
      $key = "$clsidBase\$($c.id)\DefaultIcon"
      if (-not ($backup.clsid | Where-Object { $_.id -eq $c.id })) {
        $vals = @{}
        if (Test-Path $key) { $p = Get-ItemProperty $key; foreach ($n in '(default)', 'empty', 'full') { if ($null -ne $p.$n) { $vals[$n] = $p.$n } } }
        $backup.clsid += [pscustomobject]@{ id = $c.id; clsidExisted = (Test-Path "$clsidBase\$($c.id)"); keyExisted = (Test-Path $key); values = $vals }
      }
      New-Item -Path $key -Force | Out-Null
      Set-ItemProperty -Path $key -Name '(default)' -Value "$(Ico $c.icon),0"
      if ($c.full) {
        Set-ItemProperty -Path $key -Name 'empty' -Value "$(Ico $c.icon),0"
        Set-ItemProperty -Path $key -Name 'full' -Value "$(Ico $c.full),0"
        # Explorer shows (default) until the bin changes state: match the current one right away.
        $items = (New-Object -ComObject Shell.Application).NameSpace(10).Items().Count
        if ($items -gt 0) { Set-ItemProperty -Path $key -Name '(default)' -Value "$(Ico $c.full),0" }
      }
      $done.clsid++
    } catch { $done.errors += "значок $($c.icon): $($_.Exception.Message)" }
  }

  $shell = New-Object -ComObject Shell.Application
  foreach ($name in $folders.Keys) {
    try {
      $dir = $shell.NameSpace($folders[$name]).Self.Path
      if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
      $ini = Join-Path $dir 'desktop.ini'
      if (-not ($backup.folders | Where-Object { $_.path -eq $dir })) {
        $backup.folders += [pscustomobject]@{
          path = $dir; iniExisted = (Test-Path -LiteralPath $ini)
          iniBase64 = if (Test-Path -LiteralPath $ini) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($ini)) } else { $null }
          iniAttributes = if (Test-Path -LiteralPath $ini) { [string](Get-Item -LiteralPath $ini -Force).Attributes } else { $null }
          dirAttributes = [string](Get-Item -LiteralPath $dir -Force).Attributes
        }
      }
      Set-IniIcon $dir (Ico $name)
      $done.folders++
    } catch { $done.errors += "папка ${name}: $($_.Exception.Message)" }
  }

  $ws = New-Object -ComObject WScript.Shell
  foreach ($d in Shortcut-Dirs) {
    foreach ($f in Get-ChildItem -LiteralPath $d -Filter *.lnk -File) {
      try {
        $s = $ws.CreateShortcut($f.FullName)
        $icon = Match-Shortcut $s.TargetPath $s.Arguments $f.BaseName
        if (-not $icon) { continue }
        if (-not ($backup.shortcuts | Where-Object { $_.path -eq $f.FullName })) {
          $backup.shortcuts += [pscustomobject]@{ path = $f.FullName; icon = $s.IconLocation }
        }
        $s.IconLocation = "$(Ico $icon),0"
        $s.Save()
        $done.shortcuts++
      } catch { $done.errors += "ярлык $($f.Name): $($_.Exception.Message)" }
    }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $backupFile) | Out-Null
  [IO.File]::WriteAllText($backupFile, ($backup | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
  Refresh-Icons
  return $done
}

# ------------------------------------------------------------------ restore
function Do-Restore {
  $b = Load-Backup
  if (-not $b) { return @{ restored = 0; errors = @('Резервной копии нет — оформление не применялось') } }
  $n = 0; $errors = @()
  foreach ($c in $b.clsid) {
    try {
      $key = "$clsidBase\$($c.id)\DefaultIcon"
      if (-not $c.clsidExisted) { if (Test-Path "$clsidBase\$($c.id)") { Remove-Item "$clsidBase\$($c.id)" -Recurse -Force } }
      elseif (-not $c.keyExisted) { if (Test-Path $key) { Remove-Item $key -Recurse -Force } }
      else {
        foreach ($name in '(default)', 'empty', 'full') {
          $v = $c.values.$name
          if ($null -ne $v) { Set-ItemProperty -Path $key -Name $name -Value $v }
          elseif ($name -ne '(default)') { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
        }
      }
      $n++
    } catch { $errors += "значок $($c.id): $($_.Exception.Message)" }
  }
  foreach ($f in $b.folders) {
    try {
      $ini = Join-Path $f.path 'desktop.ini'
      if (Test-Path -LiteralPath $ini) { [IO.File]::SetAttributes($ini, 'Normal') }
      if ($f.iniExisted) {
        [IO.File]::WriteAllBytes($ini, [Convert]::FromBase64String($f.iniBase64))
        [IO.File]::SetAttributes($ini, [IO.FileAttributes]$f.iniAttributes)
      } elseif (Test-Path -LiteralPath $ini) { Remove-Item -LiteralPath $ini -Force }
      (Get-Item -LiteralPath $f.path -Force).Attributes = [IO.FileAttributes]$f.dirAttributes
      $n++
    } catch { $errors += "папка $($f.path): $($_.Exception.Message)" }
  }
  $ws = New-Object -ComObject WScript.Shell
  foreach ($s in $b.shortcuts) {
    try {
      if (Test-Path -LiteralPath $s.path) { $l = $ws.CreateShortcut($s.path); $l.IconLocation = $s.icon; $l.Save(); $n++ }
    } catch { $errors += "ярлык $($s.path): $($_.Exception.Message)" }
  }
  if (-not $errors.Count) { Remove-Item $backupFile -Force }
  Refresh-Icons
  return @{ restored = $n; errors = $errors }
}

$result = switch ($Action) {
  'apply' { Do-Apply }
  'restore' { Do-Restore }
  'status' { $b = Load-Backup; @{ applied = [bool]$b; since = if ($b) { $b.created } else { $null } } }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$result | ConvertTo-Json -Compress -Depth 4
