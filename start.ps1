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

# 2. Start Vexa container.
# 以「容器建立時的 image 名稱」(Config.Image) 來定位，而非 `ancestor=...:latest` filter。
# 原因：當 vexaai/vexa-lite:latest 這個 tag 被重新 pull 指到新 image，但你正在用的容器
# 仍是舊 image 時，ancestor filter 會解析到新 image，導致 (a) 找不到正在跑的容器，或
# (b) 挑到另一顆用新 image 建、但其實是空的容器（多顆容器並存時）。
# 因此這裡優先選「正在執行中、且 image 名稱符合」的那顆（通常就是有資料的容器）。
Write-Host "Locating Vexa container..." -ForegroundColor Cyan

function Find-VexaContainer {
    param([switch]$IncludeStopped)
    $ids = if ($IncludeStopped) { docker ps -aq 2>$null } else { docker ps -q 2>$null }
    foreach ($id in $ids) {
        $img = (docker inspect $id --format '{{.Config.Image}}' 2>$null)
        if ($img -like 'vexaai/vexa-lite*') { return $id }
    }
    return $null
}

# 先找正在跑的（有資料、healthy 的那顆優先）
$vexaId = Find-VexaContainer
if ($vexaId) {
    Write-Host "Vexa container already running (ID: $vexaId)." -ForegroundColor Green
} else {
    # 沒有在跑的，再找已停止的並啟動
    $vexaId = Find-VexaContainer -IncludeStopped
    if (-not $vexaId) {
        Write-Host "Warning: No container found for image 'vexaai/vexa-lite'." -ForegroundColor Yellow
        Write-Host "Please create it first by following docs/09-實作計畫/00-vexa-lite-local.md." -ForegroundColor Yellow
    } else {
        docker start $vexaId 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Warning: failed to start Vexa container (ID: $vexaId)." -ForegroundColor Yellow
        } else {
            Write-Host "Vexa container started (ID: $vexaId)." -ForegroundColor Green
        }
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
