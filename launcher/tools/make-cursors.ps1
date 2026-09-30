# Generates the J.A.R.V.I.S. cursor set (launcher\icons\cursors\*.cur): dark navy shapes with a cyan
# outline and glow. Each .cur holds 32/48/64/96 px images (Windows picks one for the cursor size / DPI),
# stored as classic 32-bit DIBs with the hotspot in the directory entry.
param([string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'icons\cursors'))

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cyan = [System.Drawing.Color]::FromArgb(92, 225, 255)
$amber = [System.Drawing.Color]::FromArgb(255, 180, 84)
$navy = [System.Drawing.Color]::FromArgb(235, 6, 17, 24)
function A([System.Drawing.Color]$c, [int]$a) { [System.Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B) }
function P([double[]]$xy, [double]$k) {
  $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  for ($i = 0; $i -lt $xy.Count; $i += 2) { $pts.Add((New-Object System.Drawing.PointF ([float]($xy[$i] * $k)), ([float]($xy[$i + 1] * $k)))) }
  return , $pts.ToArray()
}

# Shapes are drawn on a 32-unit grid and scaled.
$arrow = @(2, 2, 2, 24, 8, 18.5, 12, 27, 15.5, 25.5, 11.6, 17, 19, 17)
function Draw-Shape($g, [double]$k, [string]$kind) {
  $g.SmoothingMode = 'AntiAlias'
  $glow = New-Object System.Drawing.Pen (A $cyan 60), ([float](3.2 * $k)); $glow.LineJoin = 'Round'
  $line = New-Object System.Drawing.Pen $cyan, ([float]([math]::Max(1, 1.2 * $k))); $line.LineJoin = 'Round'
  $fill = New-Object System.Drawing.SolidBrush $navy
  $dot = New-Object System.Drawing.SolidBrush $cyan
  function Poly($xy) { $p = P $xy $k; $g.FillPolygon($fill, $p); $g.DrawPolygon($glow, $p); $g.DrawPolygon($line, $p) }
  function Ring($cx, $cy, $r, $w, $col, $start, $sweep) {
    $pen = New-Object System.Drawing.Pen $col, ([float]($w * $k))
    $g.DrawArc($pen, [float](($cx - $r) * $k), [float](($cy - $r) * $k), [float](2 * $r * $k), [float](2 * $r * $k), $start, $sweep)
  }
  function DoubleArrow($x1, $y1, $x2, $y2) {
    # Shaft + two heads along the line, drawn as one outlined polygon.
    $dx = $x2 - $x1; $dy = $y2 - $y1; $len = [math]::Sqrt($dx * $dx + $dy * $dy); $ux = $dx / $len; $uy = $dy / $len; $nx = -$uy; $ny = $ux
    $h = 6; $w = 5; $s = 1.6
    $pts = @(
      $x1, $y1,
      ($x1 + $ux * $h + $nx * $w), ($y1 + $uy * $h + $ny * $w),
      ($x1 + $ux * $h + $nx * $s), ($y1 + $uy * $h + $ny * $s),
      ($x2 - $ux * $h + $nx * $s), ($y2 - $uy * $h + $ny * $s),
      ($x2 - $ux * $h + $nx * $w), ($y2 - $uy * $h + $ny * $w),
      $x2, $y2,
      ($x2 - $ux * $h - $nx * $w), ($y2 - $uy * $h - $ny * $w),
      ($x2 - $ux * $h - $nx * $s), ($y2 - $uy * $h - $ny * $s),
      ($x1 + $ux * $h - $nx * $s), ($y1 + $uy * $h - $ny * $s),
      ($x1 + $ux * $h - $nx * $w), ($y1 + $uy * $h - $ny * $w))
    Poly $pts
  }
  switch ($kind) {
    'arrow' { Poly $arrow }
    'link' { Poly $arrow; Ring 22 22 6 2.2 $cyan 0 360; $g.FillEllipse($dot, [float](20.5 * $k), [float](20.5 * $k), [float](3 * $k), [float](3 * $k)) }
    'working' { Poly $arrow; Ring 23 23 6.5 2.4 (A $cyan 90) 0 360; Ring 23 23 6.5 2.4 $cyan 300 120 }
    'busy' { Ring 16 16 12 3 (A $cyan 70) 0 360; Ring 16 16 12 3 $cyan 290 110; Ring 16 16 6.5 1.4 (A $cyan 160) 0 360; $g.FillEllipse($dot, [float](13.5 * $k), [float](13.5 * $k), [float](5 * $k), [float](5 * $k)) }
    'help' { Poly $arrow; $f = New-Object System.Drawing.Font 'Bahnschrift', ([float](12 * $k)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel); $g.DrawString('?', $f, $dot, [float](19 * $k), [float](15 * $k)) }
    'text' {
      $w = [math]::Max(1.5, 1.6 * $k)
      $outer = New-Object System.Drawing.Pen $navy, ([float]($w + 2.2 * $k)); $outer.StartCap = 'Round'; $outer.EndCap = 'Round'
      $inner = New-Object System.Drawing.Pen $cyan, ([float]$w); $inner.StartCap = 'Round'; $inner.EndCap = 'Round'
      foreach ($pen in @($outer, $inner)) {
        $g.DrawLine($pen, [float](16 * $k), [float](5 * $k), [float](16 * $k), [float](27 * $k))
        $g.DrawLine($pen, [float](11.5 * $k), [float](4 * $k), [float](20.5 * $k), [float](4 * $k))
        $g.DrawLine($pen, [float](11.5 * $k), [float](28 * $k), [float](20.5 * $k), [float](28 * $k))
      }
    }
    'cross' {
      Ring 16 16 8 1.4 (A $cyan 150) 0 360
      $pen = New-Object System.Drawing.Pen $cyan, ([float]([math]::Max(1, 1.4 * $k)))
      foreach ($seg in @(@(16, 2, 16, 11), @(16, 21, 16, 30), @(2, 16, 11, 16), @(21, 16, 30, 16))) {
        $g.DrawLine($pen, [float]($seg[0] * $k), [float]($seg[1] * $k), [float]($seg[2] * $k), [float]($seg[3] * $k)) }
      $g.FillEllipse($dot, [float](15 * $k), [float](15 * $k), [float](2 * $k), [float](2 * $k))
    }
    'ns' { DoubleArrow 16 3 16 29 }
    'ew' { DoubleArrow 3 16 29 16 }
    'nwse' { DoubleArrow 6 6 26 26 }
    'nesw' { DoubleArrow 26 6 6 26 }
    'move' { DoubleArrow 16 3 16 29; DoubleArrow 3 16 29 16 }
    'up' { Poly @(16, 3, 26, 14, 19, 14, 19, 29, 13, 29, 13, 14, 6, 14) }
    'no' {
      $pen = New-Object System.Drawing.Pen $amber, ([float](3 * $k)); $halo = New-Object System.Drawing.Pen (A $amber 60), ([float](5.5 * $k))
      foreach ($p in @($halo, $pen)) {
        $g.DrawEllipse($p, [float](6 * $k), [float](6 * $k), [float](20 * $k), [float](20 * $k))
        $g.DrawLine($p, [float](9 * $k), [float](23 * $k), [float](23 * $k), [float](9 * $k))
      }
    }
    'pen' { Poly @(4, 28, 6, 21, 22, 5, 27, 10, 11, 26) }
  }
}

# name = shape, hotspot on the 32 grid
$cursors = [ordered]@{
  'arrow' = @('arrow', 2, 2); 'link' = @('link', 2, 2); 'working' = @('working', 2, 2); 'busy' = @('busy', 16, 16)
  'help' = @('help', 2, 2); 'text' = @('text', 16, 16); 'cross' = @('cross', 16, 16); 'ns' = @('ns', 16, 16)
  'ew' = @('ew', 16, 16); 'nwse' = @('nwse', 16, 16); 'nesw' = @('nesw', 16, 16); 'move' = @('move', 16, 16)
  'up' = @('up', 16, 3); 'no' = @('no', 16, 16); 'pen' = @('pen', 4, 28)
}

function Dib([System.Drawing.Bitmap]$bmp) {
  $s = $bmp.Width
  $ms = New-Object System.IO.MemoryStream; $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([UInt32]40); $bw.Write([Int32]$s); $bw.Write([Int32]($s * 2)); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]0); $bw.Write([UInt32]0); $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  for ($y = $s - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $s; $x++) { $c = $bmp.GetPixel($x, $y); $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A) } }
  $maskRow = [int]([math]::Ceiling($s / 32.0) * 4)
  $bw.Write((New-Object byte[] ($maskRow * $s)))   # AND mask: all 0, alpha does the work
  $bw.Flush(); return , $ms.ToArray()
}

$sizes = 32, 48, 64, 96
$preview = New-Object System.Drawing.Bitmap ($cursors.Count * 60 + 10), 70
$pg = [System.Drawing.Graphics]::FromImage($preview); $pg.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$n = 0
foreach ($name in $cursors.Keys) {
  $spec = $cursors[$name]
  $images = @(); $hot = @()
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp); Draw-Shape $g ($s / 32.0) $spec[0]; $g.Dispose()
    $images += , (Dib $bmp); $hot += , @([int]($spec[1] * $s / 32), [int]($spec[2] * $s / 32))
    if ($s -eq 48) { $pg.DrawImage($bmp, 10 + $n * 60, 10, 48, 48) }
  }
  $fs = [System.IO.File]::Create((Join-Path $OutDir "$name.cur")); $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([UInt16]0); $bw.Write([UInt16]2); $bw.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]$hot[$i][0]); $bw.Write([UInt16]$hot[$i][1])
    $bw.Write([UInt32]$images[$i].Length); $bw.Write([UInt32]$offset); $offset += $images[$i].Length
  }
  foreach ($img in $images) { $bw.Write($img) }
  $bw.Close(); $n++
}
$preview.Save((Join-Path $OutDir 'strip.png'))
"cursors: $($cursors.Count) -> $OutDir"
