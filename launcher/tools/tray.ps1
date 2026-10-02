# J.A.R.V.I.S. tray icon: what is running, stop the agent / local model / ComfyUI / Telegram bot one by one or
# all at once, quit completely. Started by the launcher (server.js); ends together with it.
param([int]$Port = 3190, [int]$ParentPid = 0, [string]$Icon = '')
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$api = "http://127.0.0.1:$Port/api"
$headers = @{ 'X-Jarvis' = '1' }
# Actions run on the launcher; a short timeout keeps the menu responsive while a long stop finishes there.
function Post([string]$action) { try { Invoke-RestMethod -Uri "$api/$action" -Method Post -Headers $headers -TimeoutSec 2 | Out-Null } catch {} }

$script:ru = $false
function L([string]$r, [string]$e) { if ($script:ru) { $r } else { $e } }

$ni = New-Object System.Windows.Forms.NotifyIcon
if ($Icon -and (Test-Path $Icon)) { $ni.Icon = New-Object System.Drawing.Icon $Icon } else { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'J.A.R.V.I.S.'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Item([scriptblock]$onClick) { $i = New-Object System.Windows.Forms.ToolStripMenuItem; $i.add_Click($onClick); [void]$menu.Items.Add($i); $i }
$miOpen = Item { Post 'ui/open' }
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miState = Item {}
$miState.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miAgent = Item { Post 'agent/stop' }
$miModel = Item { Post 'model/stop' }
$miComfy = Item { Post 'comfy/stop' }
$miBot = Item { Post 'tg/stop' }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miAll = Item { Post 'shutdown' }
$miQuit = Item {
  $msg = L 'Остановить агента, модель, ComfyUI, Telegram-бота и обои HUD и закрыть J.A.R.V.I.S.?' 'Stop the agent, the model, ComfyUI, the Telegram bot and the HUD wallpaper and close J.A.R.V.I.S.?'
  $answer = [System.Windows.Forms.MessageBox]::Show($msg, 'J.A.R.V.I.S.', 'YesNo', 'Question')
  if ($answer -eq 'Yes') { Post 'quit' }
}
$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Post 'ui/open' })

$script:fails = 0
function Refresh {
  if ($ParentPid -and -not (Get-Process -Id $ParentPid)) { Quit-Tray; return }
  $s = $null
  try { $s = Invoke-RestMethod -Uri "$api/tray" -TimeoutSec 2 } catch {}
  if (-not $s) { if (++$script:fails -ge 5) { Quit-Tray }; return }
  $script:fails = 0
  $script:ru = $s.lang -eq 'ru'
  $agentOn = $s.agent -in 'starting', 'on'
  $modelOn = $s.model -in 'loading', 'on'
  $miOpen.Text = L 'Открыть J.A.R.V.I.S.' 'Open J.A.R.V.I.S.'
  $parts = @()
  $parts += if ($agentOn) { L 'агент в сети' 'agent online' } else { L 'агент выключен' 'agent off' }
  if ($modelOn) { $parts += L 'модель загружена' 'model loaded' }
  if ($s.comfy) { $parts += 'ComfyUI' }
  if ($s.telegram) { $parts += L 'бот' 'bot' }
  $miState.Text = ($parts -join ' · ')
  $miAgent.Text = L 'Остановить агента' 'Stop the agent';            $miAgent.Enabled = $agentOn
  $miModel.Text = L 'Выгрузить локальную модель' 'Unload the local model'; $miModel.Enabled = $modelOn
  $miComfy.Text = L 'Остановить ComfyUI' 'Stop ComfyUI';                $miComfy.Enabled = [bool]$s.comfy
  $miBot.Text = L 'Остановить Telegram-бота' 'Stop the Telegram bot';   $miBot.Enabled = [bool]$s.telegram
  $miAll.Text = L 'Остановить всё' 'Stop everything';                   $miAll.Enabled = $agentOn -or $modelOn -or $s.comfy -or $s.telegram
  $miQuit.Text = L 'Выйти полностью' 'Quit completely'
  $tip = 'J.A.R.V.I.S. · ' + ($parts -join ' · ')
  $ni.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
}
function Quit-Tray { $timer.Stop(); $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Refresh })
Refresh
$ni.Visible = $true
$timer.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
