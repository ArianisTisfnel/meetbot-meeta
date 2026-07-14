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

# 2. Start local infrastructure (Postgres, MinIO, vexa-lite) via docker-compose.
Write-Host "Starting local infrastructure (Postgres, MinIO, vexa-lite)..." -ForegroundColor Cyan
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "docker compose up failed." -ForegroundColor Red
    exit 1
}

$timeout = 60
$elapsed = 0
$health = $null
do {
    $health = docker inspect meetbot-postgres --format '{{.State.Health.Status}}' 2>$null
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 2
    $elapsed += 2
} while ($elapsed -lt $timeout)
if ($health -ne 'healthy') {
    Write-Host "Postgres did not become healthy in time." -ForegroundColor Red
    exit 1
}
Write-Host "Local infrastructure ready." -ForegroundColor Green

# 3. Install dependencies (auto-picks up new packages after a git pull).
# npm install 在沒有新套件時幾乎是 no-op（只比對 package-lock），所以每次啟動都跑沒關係，
# 好處是組員拉完最新程式碼後不必記得手動安裝新相依（例如 nodemailer）。
Write-Host "Installing dependencies (backend + frontend)..." -ForegroundColor Cyan
Set-Location "$rootDir\backend"
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Warning: backend npm install failed." -ForegroundColor Yellow }
Set-Location "$rootDir\frontend"
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Warning: frontend npm install failed." -ForegroundColor Yellow }
Write-Host "Dependencies ready." -ForegroundColor Green

# 4. Apply Prisma schema (db push) and generate Prisma client
Write-Host "Applying Prisma schema (db push)..." -ForegroundColor Cyan
Set-Location "$rootDir\backend"
npx prisma db push 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Warning: prisma db push failed." -ForegroundColor Yellow }

Write-Host "Generating Prisma client..." -ForegroundColor Cyan
npx prisma generate 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: prisma generate failed. Backend may not start correctly." -ForegroundColor Yellow
} else {
    Write-Host "Prisma client ready." -ForegroundColor Green
}

# 5. Start ngrok tunnel for Recall realtime webhook.
# Recall POSTs realtime transcript/chat to RECALL_WEBHOOK_URL, forwarded to local backend(4000).
# The domain is read from each developer's backend\.env (authtoken is stored in ngrok config).
Write-Host "Starting ngrok tunnel (Recall webhook)..." -ForegroundColor Cyan
# 優先用專案內 tools\ngrok.exe；沒有就退回 PATH 上的 ngrok（例如 winget / App Execution Alias 安裝的）。
$ngrokExe = "$rootDir\tools\ngrok.exe"
if (-not (Test-Path $ngrokExe)) {
    $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
    if ($ngrokCmd) { $ngrokExe = $ngrokCmd.Source }
}
$webhookUrl = $null
$envFile = "$rootDir\backend\.env"
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*RECALL_WEBHOOK_URL=' | Select-Object -First 1
    if ($line) { $webhookUrl = ($line.Line -replace '^\s*RECALL_WEBHOOK_URL=', '').Trim().Trim('"') }
}
if (-not (Test-Path $ngrokExe)) {
    Write-Host "Note: ngrok not found (neither tools\ngrok.exe nor on PATH) -> skipping ngrok (Recall realtime voice/chat will not work; everything else is fine)." -ForegroundColor Yellow
} elseif (-not $webhookUrl) {
    Write-Host "Note: RECALL_WEBHOOK_URL not set in backend\.env -> skipping ngrok (Recall realtime will not work)." -ForegroundColor Yellow
} elseif (Get-Process ngrok -ErrorAction SilentlyContinue) {
    Write-Host "ngrok already running." -ForegroundColor Green
} else {
    Start-Process -FilePath $ngrokExe -ArgumentList 'http', "--url=$webhookUrl", '4000' -WindowStyle Minimized
    Write-Host "ngrok started -> $webhookUrl" -ForegroundColor Green
}

# 6. Start backend + frontend together (Ctrl+C stops both)
Write-Host ""
Write-Host "Starting backend (port 4000) and frontend (port 3000)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Gray
Write-Host "(ngrok runs in a separate minimized window; to stop it: Stop-Process -Name ngrok)" -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
