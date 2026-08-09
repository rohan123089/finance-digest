@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if exist "%~dp0FinanceHub.exe" (
  start "" "%~dp0FinanceHub.exe"
  exit /b 0
)

echo FinanceHub.exe is missing. Building it now...
powershell -ExecutionPolicy Bypass -File "%~dp0desktop-app\build.ps1"
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
start "" "%~dp0FinanceHub.exe"
exit /b 0
