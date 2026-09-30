# Desktop shortcut entry point: starts the J.A.R.V.I.S. launcher server hidden
# (or, if it already runs, just brings its window back).
# -SetupLook / -SetupIcons: sent by the installer on the first start to set up the chosen Windows look.
param([switch]$SetupLook, [switch]$SetupIcons)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$data = Join-Path $root 'data\launcher'
New-Item -ItemType Directory -Force -Path $data | Out-Null
# Portable Node.js from the install folder first, the system one otherwise.
$node = @((Join-Path $root 'runtime\node\node.exe'), (Join-Path $env:ProgramFiles 'nodejs\node.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
$api = 'http://127.0.0.1:3190/api'
$headers = @{ 'X-Jarvis' = '1' }

function Ping { try { Invoke-WebRequest -Uri "$api/ping" -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }

if (Ping) {
  try { Invoke-WebRequest -Uri "$api/ui/open" -Method Post -Headers $headers -UseBasicParsing -TimeoutSec 3 | Out-Null } catch {}
} else {
  if (-not $node) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Не найден Node.js. Переустановите J.A.R.V.I.S.", 'J.A.R.V.I.S.', 'OK', 'Error') | Out-Null
    exit 1
  }
  Start-Process -FilePath $node -ArgumentList "`"$here\server.js`"" -WorkingDirectory $here -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $data 'server.out.log') -RedirectStandardError (Join-Path $data 'server.err.log')
}

if ($SetupLook -or $SetupIcons) {
  for ($i = 0; $i -lt 40 -and -not (Ping); $i++) { Start-Sleep -Milliseconds 500 }
  if ($SetupIcons) { try { Invoke-WebRequest -Uri "$api/win/apply" -Method Post -Headers $headers -UseBasicParsing -TimeoutSec 120 | Out-Null } catch {} }
  if ($SetupLook) { try { Invoke-WebRequest -Uri "$api/taskbar/install" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 10 | Out-Null } catch {} }
}
