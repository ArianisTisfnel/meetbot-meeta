# meetbot dev environment startup script
# Usage: double-click start.bat, or run .\start.ps1 from project root

$rootDir = $PSScriptRoot

# 1. Check Docker Desktop
Write-Host "Checking Docker Desktop..." -ForegroundColor Cyan
docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop is not running. Please start it manually and re-run this script." -ForegroundColor Red
    exit 1
}
Write-Host "Docker Desktop is ready." -ForegroundColor Green

# 2. Start Vexa container
Write-Host "Starting Vexa container..." -ForegroundColor Cyan
$vexaId = "d59225c69e68"
docker start $vexaId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: failed to start Vexa container (ID: $vexaId)." -ForegroundColor Yellow
    Write-Host "If the container does not exist, follow docs/09-setup/00-vexa-lite-local.md to recreate it." -ForegroundColor Yellow
} else {
    Write-Host "Vexa container started." -ForegroundColor Green
}

# 3. Start backend + frontend together (Ctrl+C stops both)
Write-Host ""
Write-Host "Starting backend (port 4000) and frontend (port 3000)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
