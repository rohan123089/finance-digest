# Build FinanceHub.exe — a real WinForms + WebView2 shell that pins as its own app.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $root
$outDir = Join-Path $root "dist"
$pkgDir = Join-Path $root "packages"
$nuget = Join-Path $pkgDir "nuget.exe"
$webviewVersion = "1.0.2903.40"

New-Item -ItemType Directory -Force -Path $outDir, $pkgDir | Out-Null

Write-Host "Preparing icon..."
$icoPath = Join-Path $root "FinanceHub.ico"
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 11, 15, 20))
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 25, 34))
$g.FillRectangle($bg, 28, 28, 200, 200)
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 94, 224, 160))
$g.FillRectangle($accent, 56, 140, 28, 60)
$g.FillRectangle($accent, 100, 100, 28, 100)
$g.FillRectangle($accent, 144, 120, 28, 80)
$blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 116, 185, 255))
$g.FillEllipse($blue, 176, 52, 36, 36)
$g.Dispose()

# Build a multi-size ICO manually
function Save-Icon([System.Drawing.Bitmap]$source, [string]$path) {
  $sizes = @(16, 32, 48, 256)
  $streams = @()
  foreach ($size in $sizes) {
    $frame = New-Object System.Drawing.Bitmap $size, $size
    $fg = [System.Drawing.Graphics]::FromImage($frame)
    $fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $fg.Clear([System.Drawing.Color]::Transparent)
    $fg.DrawImage($source, 0, 0, $size, $size)
    $fg.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $frame.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frame.Dispose()
    $streams += ,@{ Size = $size; Bytes = $ms.ToArray(); Stream = $ms }
  }
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([uint16]0)      # reserved
  $bw.Write([uint16]1)      # icon
  $bw.Write([uint16]$sizes.Count)
  $offset = 6 + (16 * $sizes.Count)
  foreach ($entry in $streams) {
    $s = $entry.Size
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$entry.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $entry.Bytes.Length
  }
  foreach ($entry in $streams) {
    $bw.Write($entry.Bytes)
    $entry.Stream.Dispose()
  }
  $bw.Flush()
  $fs.Dispose()
}
Save-Icon $bmp $icoPath
$bmp.Dispose()

Write-Host "Fetching WebView2 package $webviewVersion..."
if (-not (Test-Path $nuget)) {
  Invoke-WebRequest -UseBasicParsing -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" -OutFile $nuget
}
$nupkgName = "Microsoft.Web.WebView2"
& $nuget install $nupkgName -Version $webviewVersion -OutputDirectory $pkgDir -ExcludeVersion -NonInteractive | Out-Host

$wvRoot = Join-Path $pkgDir $nupkgName
$lib = Join-Path $wvRoot "lib\net462"
$native = Join-Path $wvRoot "runtimes\win-x64\native\WebView2Loader.dll"
if (-not (Test-Path (Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll"))) {
  throw "WebView2 WinForms assembly missing under $lib"
}

Write-Host "Compiling FinanceHub.exe..."
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$exe = Join-Path $outDir "FinanceHub.exe"
$refs = @(
  "System.dll",
  "System.Drawing.dll",
  "System.Windows.Forms.dll",
  "System.Net.dll",
  (Join-Path $lib "Microsoft.Web.WebView2.Core.dll"),
  (Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll")
)
$refArgs = ($refs | ForEach-Object { "/r:`"$_`"" }) -join " "

$win32icon = "/win32icon:`"$icoPath`""
$cmd = "& `"$csc`" /nologo /target:winexe /platform:x64 /optimize+ /out:`"$exe`" $win32icon $refArgs `"$root\FinanceHubApp.cs`""
Invoke-Expression $cmd
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit $LASTEXITCODE" }

Copy-Item (Join-Path $lib "Microsoft.Web.WebView2.Core.dll") $outDir -Force
Copy-Item (Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll") $outDir -Force
# Core depends on this satellite assembly name in some versions
$coreXml = Join-Path $lib "Microsoft.Web.WebView2.Core.xml"
if (Test-Path $coreXml) { Copy-Item $coreXml $outDir -Force }
Copy-Item $native $outDir -Force

# Also place a copy at project root for easy launching
Copy-Item $exe (Join-Path $projectRoot "FinanceHub.exe") -Force
Copy-Item (Join-Path $outDir "Microsoft.Web.WebView2.Core.dll") $projectRoot -Force
Copy-Item (Join-Path $outDir "Microsoft.Web.WebView2.WinForms.dll") $projectRoot -Force
Copy-Item (Join-Path $outDir "WebView2Loader.dll") $projectRoot -Force
Copy-Item $icoPath (Join-Path $projectRoot "FinanceHub.ico") -Force

Write-Host ""
Write-Host "Built: $exe"
Write-Host "Also copied to: $(Join-Path $projectRoot 'FinanceHub.exe')"
