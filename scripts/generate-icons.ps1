# Generates build/icon.png (1024) and build/icon.ico (16..256, PNG-compressed).
# The mark mirrors the in-app Biframe symbol: a framed sheet with a play glyph.
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\build')
)

Add-Type -AssemblyName System.Drawing

$out = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-RoundedPath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$size = 1024
$canvas = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = New-RoundedPath 56 56 912 912 196
$backgroundBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#17171A'))
$graphics.FillPath($backgroundBrush, $background)

$edgePen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#33333B'), 6)
$graphics.DrawPath($edgePen, $background)

$frame = New-RoundedPath 222 222 580 580 128
$framePen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#F1F0EC'), 24)
$framePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawPath($framePen, $frame)

$play = New-Object System.Drawing.Drawing2D.GraphicsPath
$points = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(414, 338),
  [System.Drawing.PointF]::new(724, 512),
  [System.Drawing.PointF]::new(414, 686)
)
$play.AddPolygon($points)
$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#5A52FF'))
$graphics.FillPath($accentBrush, $play)

$canvas.Save((Join-Path $out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$payloads = @()
foreach ($target in $sizes) {
  $scaled = New-Object System.Drawing.Bitmap($target, $target)
  $scaleGraphics = [System.Drawing.Graphics]::FromImage($scaled)
  $scaleGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $scaleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scaleGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $scaleGraphics.Clear([System.Drawing.Color]::Transparent)
  $scaleGraphics.DrawImage($canvas, 0, 0, $target, $target)
  $temp = Join-Path $out ("icon-{0}.png" -f $target)
  $scaled.Save($temp, [System.Drawing.Imaging.ImageFormat]::Png)
  $payloads += @{ Size = $target; Bytes = [System.IO.File]::ReadAllBytes($temp) }
  $scaleGraphics.Dispose()
  $scaled.Dispose()
  Remove-Item -Force $temp
}

$icoPath = Join-Path $out 'icon.ico'
$stream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$payloads.Count)
$offset = 6 + (16 * $payloads.Count)
foreach ($entry in $payloads) {
  $dimension = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
  $writer.Write([byte]$dimension)
  $writer.Write([byte]$dimension)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$entry.Bytes.Length)
  $writer.Write([uint32]$offset)
  $offset += $entry.Bytes.Length
}
foreach ($entry in $payloads) {
  $writer.Write($entry.Bytes)
}
$writer.Flush()
$stream.Close()

$graphics.Dispose()
$canvas.Dispose()
Write-Output ("icon.png and icon.ico written to {0}" -f $out)
