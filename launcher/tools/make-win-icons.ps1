# Generates the J.A.R.V.I.S.-style Windows icons (launcher\icons\windows\*.ico) + a preview sheet.
# Each size is drawn natively (no downscaling): big sizes get HUD ticks and arcs, small ones stay crisp.
# Glyphs come from the Segoe Fluent Icons font that ships with Windows 11.
param([string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'icons\windows'))

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cyan  = [System.Drawing.Color]::FromArgb(92, 225, 255)
$amber = [System.Drawing.Color]::FromArgb(255, 180, 84)

# name = glyph code point, optional accent
$icons = [ordered]@{
  'this-pc'      = @{ glyph = 0xE977 }
  'recycle-empty'= @{ glyph = 0xE74D }
  'recycle-full' = @{ glyph = 0xE74D; accent = $amber }
  'network'      = @{ glyph = 0xE774 }
  'user'         = @{ glyph = 0xE77B }
  'control'      = @{ glyph = 0xE713 }
  'folder'       = @{ glyph = 0xE8B7 }
  'documents'    = @{ glyph = 0xE8A5 }
  'downloads'    = @{ glyph = 0xE896 }
  'pictures'     = @{ glyph = 0xE91B }
  'music'        = @{ glyph = 0xEC4F }
  'videos'       = @{ glyph = 0xE714 }
  'desktop'      = @{ glyph = 0xE7F4 }
  'telegram'     = @{ glyph = 0xE724 }
  'discord'      = @{ glyph = 0xE7FC }
  'torrent'      = @{ glyph = 0xE896; accent = $amber }
  'capcut'       = @{ glyph = 0xE8C6 }
  'video-dl'     = @{ glyph = 0xE768 }
  'blender'      = @{ glyph = 0xE950 }
  'browser'      = @{ glyph = 0xE774; accent = $amber }
  'app'          = @{ glyph = 0xE8FC }
}

function New-Color([System.Drawing.Color]$c, [int]$a) { [System.Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B) }

function Draw-Icon([int]$S, [int]$glyph, [System.Drawing.Color]$acc) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.PixelOffsetMode = 'HighQuality'
  $k = $S / 256.0
  $c = $S / 2.0
  $R = 120 * $k
  # Dark disc with a soft inner light.
  $disc = New-Object System.Drawing.Drawing2D.GraphicsPath
  $disc.AddEllipse($c - $R, $c - $R, 2 * $R, 2 * $R)
  $pg = New-Object System.Drawing.Drawing2D.PathGradientBrush $disc
  $pg.CenterColor = [System.Drawing.Color]::FromArgb(255, 14, 44, 58)
  $pg.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 3, 8, 12))
  $g.FillPath($pg, $disc)
  # Outer ring.
  $ringW = if ($S -le 24) { 1.0 } else { [math]::Max(1.2, 7 * $k) }
  $g.DrawEllipse((New-Object System.Drawing.Pen (New-Color $acc 235), $ringW), $c - $R + $ringW / 2, $c - $R + $ringW / 2, 2 * $R - $ringW, 2 * $R - $ringW)
  if ($S -ge 48) {
    # Tick marks.
    $tp = New-Object System.Drawing.Pen (New-Color $acc 140), ([math]::Max(1, 2.2 * $k))
    for ($i = 0; $i -lt 48; $i++) {
      $a = $i * [math]::PI * 2 / 48
      $r1 = $(if ($i % 4 -eq 0) { 96 } else { 101 }) * $k; $r2 = 107 * $k
      $g.DrawLine($tp, $c + [math]::Cos($a) * $r1, $c + [math]::Sin($a) * $r1, $c + [math]::Cos($a) * $r2, $c + [math]::Sin($a) * $r2)
    }
    # Two bright HUD arcs.
    $ap = New-Object System.Drawing.Pen (New-Color $acc 255), (9 * $k)
    $ar = 113 * $k
    $g.DrawArc($ap, $c - $ar, $c - $ar, 2 * $ar, 2 * $ar, 300, 50)
    $g.DrawArc($ap, $c - $ar, $c - $ar, 2 * $ar, 2 * $ar, 120, 50)
    # Inner thin ring.
    $ir = 88 * $k
    $g.DrawEllipse((New-Object System.Drawing.Pen (New-Color $acc 70), ([math]::Max(1, 2 * $k))), $c - $ir, $c - $ir, 2 * $ir, 2 * $ir)
  }
  # Glow behind the glyph.
  $gr = 70 * $k
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glowPath.AddEllipse($c - $gr, $c - $gr, 2 * $gr, 2 * $gr)
  $gb = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
  $gb.CenterColor = New-Color $acc 70
  $gb.SurroundColors = @((New-Color $acc 0))
  $g.FillPath($gb, $glowPath)
  # Glyph: bigger relative size on tiny icons so it stays readable.
  $rel = if ($S -le 16) { 0.74 } elseif ($S -le 24) { 0.66 } elseif ($S -le 32) { 0.58 } else { 0.46 }
  $font = New-Object System.Drawing.Font 'Segoe Fluent Icons', ([float]($S * $rel)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $txt = [string][char]$glyph
  $rect = New-Object System.Drawing.RectangleF 0, ([float](1 * $k)), $S, $S
  if ($S -ge 48) {
    # Soft halo: the glyph drawn a few times slightly offset at low alpha.
    $halo = New-Object System.Drawing.SolidBrush (New-Color $acc 45)
    foreach ($d in @(-2, 2)) { foreach ($e in @(-2, 2)) {
      $g.DrawString($txt, $font, $halo, (New-Object System.Drawing.RectangleF ([float]($d * $k)), ([float](1 * $k + $e * $k)), $S, $S), $sf) } }
  }
  $light = [System.Drawing.Color]::FromArgb(255, [math]::Min(255, $acc.R + 70), [math]::Min(255, $acc.G + 25), [math]::Min(255, $acc.B + 10))
  $g.DrawString($txt, $font, (New-Object System.Drawing.SolidBrush $light), $rect, $sf)
  $g.Dispose()
  return $bmp
}

function Save-Ico([string]$path, [System.Drawing.Bitmap[]]$bitmaps) {
  $pngs = foreach ($b in $bitmaps) { $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); , $ms.ToArray() }
  $fs = [System.IO.File]::Create($path); $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$bitmaps.Count)
  $offset = 6 + 16 * $bitmaps.Count
  for ($i = 0; $i -lt $bitmaps.Count; $i++) {
    $s = $bitmaps[$i].Width
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$pngs[$i].Length); $bw.Write([UInt32]$offset); $offset += $pngs[$i].Length
  }
  foreach ($p in $pngs) { $bw.Write($p) }
  $bw.Close()
}

$sizes = 256, 128, 64, 48, 32, 24, 16
$sheet = New-Object System.Drawing.Bitmap (($icons.Count) * 110 + 20), 330
$sg = [System.Drawing.Graphics]::FromImage($sheet); $sg.Clear([System.Drawing.Color]::FromArgb(20, 24, 28))
$lab = New-Object System.Drawing.Font 'Segoe UI', 9
$i = 0
foreach ($name in $icons.Keys) {
  $spec = $icons[$name]
  $acc = if ($spec.accent) { $spec.accent } else { $cyan }
  $bmps = foreach ($s in $sizes) { Draw-Icon $s $spec.glyph $acc }
  Save-Ico (Join-Path $OutDir "$name.ico") $bmps
  $x = 20 + $i * 110
  $sg.DrawImage($bmps[2], $x, 10, 96, 96)      # 64 px drawn at 96
  $sg.DrawImage($bmps[4], $x + 30, 130, 32, 32) # 32 px 1:1
  $sg.DrawImage($bmps[6], $x + 38, 180, 16, 16) # 16 px 1:1
  $sg.DrawString($name, $lab, [System.Drawing.Brushes]::White, $x, 220)
  $i++
}
$sheet.Save((Join-Path $OutDir 'preview.png'))
# Compact strip for the launcher (48 px icons in a row).
$strip = New-Object System.Drawing.Bitmap ($icons.Count * 56 + 8), 60
$stg = [System.Drawing.Graphics]::FromImage($strip); $stg.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$j = 0
foreach ($name in $icons.Keys) { $spec = $icons[$name]; $acc = if ($spec.accent) { $spec.accent } else { $cyan }; $stg.DrawImage((Draw-Icon 48 $spec.glyph $acc), 6 + $j * 56, 6, 48, 48); $j++ }
$strip.Save((Join-Path $OutDir 'strip.png'))
"icons: $($icons.Count) -> $OutDir"
