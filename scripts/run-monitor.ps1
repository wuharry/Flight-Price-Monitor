$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectDirectory
try {
    & node (Join-Path $projectDirectory 'dist/src/index.js') --run-once
    $monitorExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $monitorExitCode
