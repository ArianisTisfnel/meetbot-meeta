# meetbot 開發環境啟動腳本
# 用途：每次電腦重開後，執行此腳本啟動所有服務
# 執行方式：雙擊 start.bat，或在專案根目錄執行 .\start.ps1

$rootDir = $PSScriptRoot

# 1. 確認 Docker Desktop 已啟動
Write-Host "檢查 Docker Desktop..." -ForegroundColor Cyan
docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop 尚未啟動，請先手動開啟 Docker Desktop，再重新執行此腳本。" -ForegroundColor Red
    exit 1
}
Write-Host "Docker Desktop 已就緒。" -ForegroundColor Green

# 2. 啟動 Vexa 容器
Write-Host "啟動 Vexa 容器..." -ForegroundColor Cyan
$vexaId = "d59225c69e68"
docker start $vexaId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "警告：Vexa 容器啟動失敗（容器 ID: $vexaId）。" -ForegroundColor Yellow
    Write-Host "若容器不存在，請參考 docs/09-實作計畫/00-vexa-lite-local.md 重新建立。" -ForegroundColor Yellow
} else {
    Write-Host "Vexa 容器已啟動。" -ForegroundColor Green
}

# 3. 啟動後端 + 前端（同一視窗，Ctrl+C 一次全停）
Write-Host ""
Write-Host "啟動後端 (port 4000) 與前端 (port 3000)..." -ForegroundColor Cyan
Write-Host "按 Ctrl+C 可同時停止所有服務。" -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
