@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

rem Allow this local script in this child only; keep the machine policy intact.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0start-preview.ps1"
set "CHAQ_EXIT=%errorlevel%"
rem Pause only after the startup guard has released its project lock.
if not "%CHAQ_NONINTERACTIVE%"=="1" pause
exit /b %CHAQ_EXIT%
