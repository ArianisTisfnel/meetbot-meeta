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

# 2. Start Vexa container (looked up by image, works regardless of container name)
Write-Host "Starting Vexa container..." -ForegroundColor Cyan
$vexaId = docker ps -aqf "ancestor=vexaai/vexa-lite:latest" 2>$null
if (-not $vexaId) {
    Write-Host "Warning: No container found for image 'vexaai/vexa-lite:latest'." -ForegroundColor Yellow
    Write-Host "Please create it first by following docs/09-實作計畫/00-vexa-lite-local.md." -ForegroundColor Yellow
} else {
    docker start $vexaId 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Warning: failed to start Vexa container (ID: $vexaId)." -ForegroundColor Yellow
    } else {
        Write-Host "Vexa container started (ID: $vexaId)." -ForegroundColor Green
    }
}

# 3. Generate Prisma client
Write-Host "Generating Prisma client..." -ForegroundColor Cyan
Set-Location "$rootDir\backend"
npx prisma generate 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: prisma generate failed. Backend may not start correctly." -ForegroundColor Yellow
} else {
    Write-Host "Prisma client ready." -ForegroundColor Green
}

# 4. Start backend + frontend together (Ctrl+C stops both)
Write-Host ""
Write-Host "Starting backend (port 4000) and frontend (port 3000)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
