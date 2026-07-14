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
# 先試「明確路徑」（不依賴 PATH）：專案內 tools\，再來是 MSIX/winget 裝的 WindowsApps 位置。
# 重點：start.bat 由 Explorer/cmd 啟動時，子 PowerShell 的 PATH 未必含 WindowsApps，導致
# Get-Command ngrok 落空 → 誤判「找不到 ngrok」→ 跳過 → 喚醒詞收不到即時字幕。改成先 Test-Path
# 明確檔案就繞開這個坑（檔案在不在跟 PATH 無關）。
$ngrokExe = $null
$ngrokCandidates = @(
    (Join-Path $rootDir 'tools\ngrok.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\ngrok.exe')
)
foreach ($c in $ngrokCandidates) { if ($c -and (Test-Path $c)) { $ngrokExe = $c; break } }
if (-not $ngrokExe) {
    # 明確路徑都沒有，最後才靠 PATH。App Execution Alias 的 .Source 可能為 $null，
    # 那就用命令名 'ngrok' 交給 Start-Process 解析（別對這名字 Test-Path）。
    $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
    if ($ngrokCmd) { $ngrokExe = if ($ngrokCmd.Source) { $ngrokCmd.Source } else { 'ngrok' } }
}
$webhookUrl = $null
$envFile = "$rootDir\backend\.env"
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*RECALL_WEBHOOK_URL=' | Select-Object -First 1
    if ($line) { $webhookUrl = ($line.Line -replace '^\s*RECALL_WEBHOOK_URL=', '').Trim().Trim('"') }
}
if (-not $ngrokExe -or -not (Test-Path $ngrokExe)) {
    Write-Host "Note: ngrok not found (neither tools\ngrok.exe nor on PATH) -> skipping ngrok (Recall realtime voice/chat will not work; everything else is fine)." -ForegroundColor Yellow
} elseif (-not $webhookUrl) {
    Write-Host "Note: RECALL_WEBHOOK_URL not set in backend\.env -> skipping ngrok (Recall realtime will not work)." -ForegroundColor Yellow
} elseif (Get-Process ngrok -ErrorAction SilentlyContinue) {
    Write-Host "ngrok already running." -ForegroundColor Green
} else {
    Start-Process -FilePath $ngrokExe -ArgumentList 'http', "--url=$webhookUrl", '4000' -WindowStyle Minimized
    Write-Host "ngrok started -> $webhookUrl" -ForegroundColor Green
}

# 6. Start cloudflared quick tunnel for the Output Media agent page (AGENT_MODE, docs/16 Plan A).
# 為什麼不用 ngrok：免費域名對「瀏覽器導覽」會插 ERR_NGROK_6024 警告頁，bot 的雲端瀏覽器
# 開不進 agent 網頁；cloudflared quick tunnel 沒有警告頁。網頁與 /ws/agent 同源，一條 tunnel 搞定。
# quick tunnel 的網址每次啟動都會變 -> 這裡自動抓網址並寫回 backend\.env 的 AGENT_PAGE_URL。
$agentModeOn = $false
if (Test-Path $envFile) {
    $modeLine = Select-String -Path $envFile -Pattern '^\s*AGENT_MODE=' | Select-Object -Last 1
    if ($modeLine -and (($modeLine.Line -replace '^\s*AGENT_MODE=', '').Trim().Trim('"') -eq 'on')) { $agentModeOn = $true }
}
# PATH 上找不到就退回 winget MSI 的預設安裝路徑（裝完當下的舊 shell 還沒有新 PATH）
$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredExe = if ($cloudflaredCmd) { $cloudflaredCmd.Source } else { "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cloudflaredExe)) { $cloudflaredExe = $null }
if (-not $agentModeOn) {
    Write-Host "AGENT_MODE is not 'on' -> skipping cloudflared (agent page tunnel)." -ForegroundColor Gray
} elseif (-not $cloudflaredExe) {
    Write-Host "Note: cloudflared not found -> agent page has no public URL; falling back to webhook+mp3 path. Install: winget install Cloudflare.cloudflared" -ForegroundColor Yellow
} else {
    if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
        Write-Host "cloudflared already running; restarting to get a fresh URL..." -ForegroundColor Gray
        Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Write-Host "Starting cloudflared quick tunnel (agent page)..." -ForegroundColor Cyan
    $cfLog = "$env:TEMP\meetbot-cloudflared.log"
    if (Test-Path $cfLog) { Remove-Item $cfLog -Force -ErrorAction SilentlyContinue }
    # quick tunnel 網址印在 stderr -> 導到檔案再輪詢解析
    Start-Process -FilePath $cloudflaredExe -ArgumentList 'tunnel', '--url', 'http://localhost:4000' `
        -WindowStyle Minimized -RedirectStandardError $cfLog
    $agentUrl = $null
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $cfLog) {
            $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
            if ($m) { $agentUrl = $m.Matches[0].Value; break }
        }
    }
    if ($agentUrl) {
        # 寫回 backend\.env（backend 啟動時讀取，所以要在 npm start 之前完成）。
        # 用 .NET API 以 UTF-8(無 BOM) 讀寫：PS 5.1 的 Get/Set-Content 預設編碼會把中文註解弄壞。
        $envContent = [System.IO.File]::ReadAllText($envFile)
        if ($envContent -match '(?m)^\s*AGENT_PAGE_URL=') {
            $envContent = $envContent -replace '(?m)^\s*AGENT_PAGE_URL=.*$', "AGENT_PAGE_URL=`"$agentUrl/agent`""
        } else {
            $envContent = $envContent.TrimEnd() + "`nAGENT_PAGE_URL=`"$agentUrl/agent`"`n"
        }
        [System.IO.File]::WriteAllText($envFile, $envContent, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "cloudflared started -> AGENT_PAGE_URL=$agentUrl/agent (written to backend\.env)" -ForegroundColor Green
    } else {
        Write-Host "Warning: cloudflared URL not detected within 15s; agent page unavailable this run (webhook+mp3 fallback still works). See $cfLog" -ForegroundColor Yellow
    }
}

# 7. Start backend + frontend together (Ctrl+C stops both)
Write-Host ""
Write-Host "Starting backend (port 4000) and frontend (port 3000)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Gray
Write-Host "(ngrok/cloudflared run in separate minimized windows; to stop: Stop-Process -Name ngrok,cloudflared)" -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
