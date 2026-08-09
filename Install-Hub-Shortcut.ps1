# Creates Desktop + Start Menu shortcuts that pin as Finance Hub (not Edge).
# Points at FinanceHub.exe - a WebView2 shell with its own AppUserModelID.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "FinanceHub.exe"
$ico = Join-Path $root "FinanceHub.ico"

if (-not (Test-Path $exe)) {
  Write-Host "FinanceHub.exe not found - building..."
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "desktop-app\build.ps1")
}
if (-not (Test-Path $exe)) {
  throw "FinanceHub.exe is still missing after build."
}

$wsh = New-Object -ComObject WScript.Shell
$name = "Finance Hub.lnk"

function New-HubShortcut([string]$folder) {
  if (-not (Test-Path $folder)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
  $path = Join-Path $folder $name
  $sc = $wsh.CreateShortcut($path)
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = $root
  $sc.WindowStyle = 1
  $sc.Description = "Finance Hub"
  if (Test-Path $ico) {
    $sc.IconLocation = "$ico,0"
  } else {
    $sc.IconLocation = "$exe,0"
  }
  $sc.Save()
  return $path
}

$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$desktopPath = New-HubShortcut $desktop
$startPath = New-HubShortcut $startMenu

Write-Host ""
Write-Host "Created:"
Write-Host "  $desktopPath"
Write-Host "  $startPath"
Write-Host ""
Write-Host "Pin to taskbar:"
Write-Host "  1. Unpin the old Edge Finance Hub entry if it is still there"
Write-Host "  2. Double-click the new Desktop Finance Hub shortcut"
Write-Host "  3. Right-click the running Finance Hub taskbar icon -> Pin to taskbar"
Write-Host ""
Write-Host "It should pin as Finance Hub, not Edge."
