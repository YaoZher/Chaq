@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist ".chaq-data\tmp" mkdir ".chaq-data\tmp"
set "TEMP=%ROOT%\.chaq-data\tmp"
set "TMP=%ROOT%\.chaq-data\tmp"
set "npm_config_cache=%ROOT%\.chaq-data\npm-cache"
set "electron_config_cache=%ROOT%\.chaq-data\electron-cache"
set "ELECTRON_BUILDER_CACHE=%ROOT%\.chaq-data\electron-builder-cache"

rem The preview is deliberately self-contained. Ignore machine-level Chaq paths
rem so data, caches and generated configuration stay under this repository.
set "CHAQ_ENV_ROOT="
set "CHAQ_ENV_FILE="
set "DOCKER_CONFIG="
set "CHAQ_PROJECT_ROOT="
set "CHAQ_RUNTIME_CACHE="
set "CHAQ_DEVTOOLS_PORT="
set "ELECTRON_RENDERER_URL="
set "ELECTRON_RUN_AS_NODE="

set "EXE=apps\desktop\release-preview\win-unpacked\Chaq.exe"
set "VITE_SERVER_URL=http://127.0.0.1:24538/api"
set "VITE_PUBLIC_SERVER_URL=http://127.0.0.1:24538/api"
set "VITE_ALLOW_LOCAL_API_FALLBACK=1"
set "VITE_FORCE_SERVER_URL=1"

echo [Chaq] Starting the self-contained local production preview...
echo [Chaq] API: http://127.0.0.1:24538/api
echo [Chaq] Data: .chaq-data
echo [Chaq] Logs: .logs

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node.js 22.12 or newer.
  goto :fail
)

node scripts\check-node-version.js
if errorlevel 1 goto :fail

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd was not found in PATH.
  goto :fail
)

node scripts\stop-preview-client.js
if errorlevel 1 goto :client_close_fail

node scripts\dependency-state.js --check
if errorlevel 1 goto :install
goto :dependencies_ready

:install
  echo [Chaq] Installing project dependencies into project-relative caches...
  node scripts\start-production-server.js --local-preview --stop
  if errorlevel 1 goto :server_fail
  node scripts\install-dependencies.js
  if errorlevel 1 goto :fail
  node scripts\dependency-state.js --check
  if errorlevel 1 goto :fail

:dependencies_ready

echo [Chaq] Preparing PostgreSQL, Redis, migrations, production API, Agent worker and preview account...
node scripts\start-production-server.js --restart --local-preview
if errorlevel 1 goto :server_fail
node scripts\smoke-local-preview.js
if errorlevel 1 goto :server_fail

if "%CHAQ_REBUILD_CLIENT%"=="1" goto :package
node scripts\package-preview-client.js --check
if errorlevel 1 goto :package
goto :launch

:package
echo [Chaq] Building a fresh localhost-only preview client...
call npm.cmd run package:preview -w @chaq/desktop
if errorlevel 1 goto :client_fail
if not exist "%EXE%" (
  echo [ERROR] Preview executable was not produced at %EXE%.
  goto :fail
)

:launch
echo [Chaq] Launching preview client...
node scripts\prepare-preview-env.js --show-login
if errorlevel 1 goto :client_fail
set "NODE_ENV=production"
set "CHAQ_ENV_ROOT=%ROOT%\.chaq-data\desktop-preview"
start "Chaq Preview" "%EXE%"
if errorlevel 1 goto :client_fail
node scripts\stop-preview-client.js --wait-running
if errorlevel 1 goto :client_fail
echo.
echo [Chaq] Preview is ready. The API and Agent worker continue in the background.
echo [Chaq] Use tools\stop-preview.bat when you want to stop the preview server.
exit /b 0

:server_fail
echo [ERROR] Local preview server startup failed.
echo [ERROR] Check .logs\api-preview.log, .logs\worker-preview.log and .chaq-data\logs\postgres.log.
node scripts\start-production-server.js --local-preview --stop
goto :fail

:client_fail
echo [ERROR] Preview client preparation or build failed. Check the message above and retry.
node scripts\start-production-server.js --local-preview --stop
goto :fail

:client_close_fail
echo [ERROR] Could not safely close the existing preview client. Save your work, close it manually, and retry.
goto :fail

:fail
echo [ERROR] Chaq local preview startup failed.
exit /b 1
