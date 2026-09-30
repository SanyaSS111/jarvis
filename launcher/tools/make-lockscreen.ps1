# Draws the J.A.R.V.I.S. lock screen picture at the primary screen resolution:
# navy gradient, HUD grid, an arc reactor below the Windows clock, corner brackets. No time on it —
# the lock screen shows its own clock.
param([string]$Out = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'data\launcher\lockscreen.png'))

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$W = [math]::Max(1920, $scr.Width); $H = [math]::Max(1080, $scr.Height)
$k = $H / 1080.0
$cyan = [System.Drawing.Color]::FromArgb(92, 225, 255)
function A([int]$a) { [System.Drawing.Color]::FromArgb($a, 92, 225, 255) }

$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'

# Background: radial navy glow.
$g.Clear([System.Drawing.Color]::FromArgb(3, 7, 10))
$cx = $W / 2; $cy = $H * 0.62
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath; $bg.AddEllipse([float]($cx - $W * 0.7), [float]($cy - $H * 0.9), [float]($W * 1.4), [float]($H * 1.8))
$pb = New-Object System.Drawing.Drawing2D.PathGradientBrush $bg
$pb.CenterPoint = New-Object System.Drawing.PointF ([float]$cx), ([float]$cy)
$pb.CenterColor = [System.Drawing.Color]::FromArgb(255, 10, 34, 46); $pb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 3, 7, 10))
$g.FillPath($pb, $bg)

# Grid.
$grid = New-Object System.Drawing.Pen (A 14), 1
for ($x = 0; $x -lt $W; $x += 44 * $k) { $g.DrawLine($grid, [float]$x, 0, [float]$x, $H) }
for ($y = 0; $y -lt $H; $y += 44 * $k) { $g.DrawLine($grid, 0, [float]$y, $W, [float]$y) }

# Arc reactor.
function Ring([double]$r, [double]$w, [int]$a, [float]$start = 0, [float]$sweep = 360, [float[]]$dash = $null) {
  $p = New-Object System.Drawing.Pen (A $a), ([float]($w * $k)); if ($dash) { $p.DashPattern = $dash }
  $rr = $r * $k
  $g.DrawArc($p, [float]($cx - $rr), [float]($cy - $rr), [float](2 * $rr), [float](2 * $rr), $start, $sweep)
}
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath; $gr = 260 * $k
$glow.AddEllipse([float]($cx - $gr), [float]($cy - $gr), [float](2 * $gr), [float](2 * $gr))
$gb = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow; $gb.CenterColor = (A 70); $gb.SurroundColors = @((A 0)); $g.FillPath($gb, $glow)
Ring 200 2 60 0 360 @(2, 6)
Ring 182 1 90
Ring 170 10 30
Ring 170 10 230 300 50
Ring 170 10 230 120 50
$ticks = New-Object System.Drawing.Pen (A 130), ([float](2 * $k))
for ($i = 0; $i -lt 72; $i++) {
  $a = $i * [math]::PI * 2 / 72; $r1 = $(if ($i % 6 -eq 0) { 142 } else { 148 }) * $k; $r2 = 156 * $k
  $g.DrawLine($ticks, [float]($cx + [math]::Cos($a) * $r1), [float]($cy + [math]::Sin($a) * $r1), [float]($cx + [math]::Cos($a) * $r2), [float]($cy + [math]::Sin($a) * $r2))
}
# Ten coils.
$coilFill = New-Object System.Drawing.SolidBrush (A 40); $coilPen = New-Object System.Drawing.Pen (A 220), ([float](1.6 * $k))
for ($i = 0; $i -lt 10; $i++) {
  $a0 = $i / 10 * [math]::PI * 2 + 0.07; $a1 = ($i + 1) / 10 * [math]::PI * 2 - 0.07
  $pts = foreach ($pr in @(@(88, $a0), @(128, ($a0 - 0.02)), @(128, ($a1 + 0.02)), @(88, $a1))) {
    New-Object System.Drawing.PointF ([float]($cx + [math]::Cos($pr[1]) * $pr[0] * $k)), ([float]($cy + [math]::Sin($pr[1]) * $pr[0] * $k)) }
  $g.FillPolygon($coilFill, $pts); $g.DrawPolygon($coilPen, $pts)
}
Ring 80 3 200
Ring 68 4 120 0 360 @(5, 2)
$core = New-Object System.Drawing.Drawing2D.GraphicsPath; $cr = 58 * $k
$core.AddEllipse([float]($cx - $cr), [float]($cy - $cr), [float](2 * $cr), [float](2 * $cr))
$cb = New-Object System.Drawing.Drawing2D.PathGradientBrush $core
$cb.CenterColor = [System.Drawing.Color]::White; $cb.SurroundColors = @((A 0))
$g.FillPath($cb, $core)
$tri = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 255, 255, 255)), ([float](2.5 * $k))
$g.DrawPolygon($tri, @(
  (New-Object System.Drawing.PointF ([float]$cx), ([float]($cy - 34 * $k))),
  (New-Object System.Drawing.PointF ([float]($cx + 29.4 * $k)), ([float]($cy + 17 * $k))),
  (New-Object System.Drawing.PointF ([float]($cx - 29.4 * $k)), ([float]($cy + 17 * $k)))))

# Wordmark under the reactor.
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'
$font = New-Object System.Drawing.Font 'Bahnschrift', ([float](34 * $k)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font 'Bahnschrift', ([float](13 * $k)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$ty = $cy + 225 * $k
$title = 'J . A . R . V . I . S .'
$g.DrawString($title, $font, (New-Object System.Drawing.SolidBrush (A 60)), (New-Object System.Drawing.RectangleF 0, ([float]($ty + 2 * $k)), $W, (60 * $k)), $sf)
$g.DrawString($title, $font, (New-Object System.Drawing.SolidBrush $cyan), (New-Object System.Drawing.RectangleF 0, ([float]$ty), $W, (60 * $k)), $sf)
$g.DrawString('JUST  A  RATHER  VERY  INTELLIGENT  SYSTEM', $small, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(160, 124, 157, 176))), (New-Object System.Drawing.RectangleF 0, ([float]($ty + 48 * $k)), $W, (30 * $k)), $sf)

# Corner brackets + scan lines.
$br = New-Object System.Drawing.Pen (A 200), ([float](2 * $k)); $m = 26 * $k; $L = 60 * $k
foreach ($c in @(@($m, $m, 1, 1), @(($W - $m), $m, -1, 1), @($m, ($H - $m), 1, -1), @(($W - $m), ($H - $m), -1, -1))) {
  $g.DrawLine($br, [float]$c[0], [float]$c[1], [float]($c[0] + $c[2] * $L), [float]$c[1])
  $g.DrawLine($br, [float]$c[0], [float]$c[1], [float]$c[0], [float]($c[1] + $c[3] * $L))
}
$scan = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(6, 255, 255, 255)), 1
for ($y = 0; $y -lt $H; $y += 3) { $g.DrawLine($scan, 0, [float]$y, $W, [float]$y) }

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$Out
