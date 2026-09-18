[CmdletBinding()]
param(
  [string]$WorkDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Work')
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previewLauncher = Join-Path $projectRoot 'tools\start-preview.bat'
$manifestPath = Join-Path $projectRoot 'package.json'
if (-not (Test-Path -LiteralPath $previewLauncher -PathType Leaf) -or
    -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).name -ne 'chaq') {
  throw 'Run this installer from the tools folder of the Chaq project.'
}

# Keep the desktop entry small: the versioned preview launcher owns setup,
# dependency checks, local services, client packaging, and failure reporting.
$template = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Chaq
set "CHAQ_ROOT=__PROJECT_ROOT__"
set "CHAQ_NONINTERACTIVE="

if not exist "%CHAQ_ROOT%\tools\start-preview.bat" goto :missing_project
pushd "%CHAQ_ROOT%"
if errorlevel 1 goto :missing_project
call tools\start-preview.bat
set "CHAQ_EXIT=%errorlevel%"
popd
exit /b %CHAQ_EXIT%

:missing_project
echo [Chaq] The project folder or local preview launcher could not be found:
echo "%CHAQ_ROOT%"
echo [Chaq] Run tools\install-work-launcher.ps1 from the project's new location.
pause
exit /b 1
'@

$outputDirectory = [IO.Path]::GetFullPath($WorkDirectory)
[void][IO.Directory]::CreateDirectory($outputDirectory)
$outputPath = Join-Path $outputDirectory 'Chaq.cmd'
$content = $template.Replace('__PROJECT_ROOT__', $projectRoot.Replace('%', '%%'))
$content = ($content -replace '\r?\n', "`r`n") + "`r`n"
[IO.File]::WriteAllText($outputPath, $content, [Text.UTF8Encoding]::new($false))
Write-Output "Chaq launcher installed: $outputPath"
