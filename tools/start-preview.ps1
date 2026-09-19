[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$startupExit = 1
$startupMutex = $null
$ownsStartupMutex = $false

try {
  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $pathBytes = [Text.Encoding]::UTF8.GetBytes($projectRoot.ToUpperInvariant())
    $pathHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($pathBytes)).Replace('-', '')
  }
  finally {
    $hashAlgorithm.Dispose()
  }

  # The OS releases ownership if this process exits unexpectedly. No stale lock
  # file can prevent the next launch; separate checkouts have separate locks.
  $startupMutex = [Threading.Mutex]::new($false, "Local\ChaqPreviewStartup-$pathHash")
  try {
    $ownsStartupMutex = $startupMutex.WaitOne(0)
  }
  catch [Threading.AbandonedMutexException] {
    $ownsStartupMutex = $true
  }

  if (-not $ownsStartupMutex) {
    Write-Output '[Chaq] This project is already starting. Please wait for the existing startup window.'
    $startupExit = 0
  }
  else {
    $runtimePath = Join-Path $PSScriptRoot 'start-preview-runtime.bat'
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
      throw 'The local preview startup script is missing. Restore tools\start-preview-runtime.bat.'
    }

    Push-Location -LiteralPath $projectRoot
    try {
      # Use a fixed relative command so checkout paths containing shell
      # metacharacters are never interpolated into cmd.exe's command text.
      & $env:ComSpec /d /s /c 'tools\start-preview-runtime.bat'
      $startupExit = $LASTEXITCODE
    }
    finally {
      Pop-Location
    }
  }
}
catch {
  Write-Output "[ERROR] Chaq local preview startup failed: $($_.Exception.Message)"
}
finally {
  if ($ownsStartupMutex) {
    $startupMutex.ReleaseMutex()
  }
  if ($null -ne $startupMutex) {
    $startupMutex.Dispose()
  }
}

exit $startupExit
