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

# 2. Start local infrastructure (Postgres, MinIO) via docker-compose.
Write-Host "Starting local infrastructure (Postgres, MinIO)..." -ForegroundColor Cyan
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

# 5. Public tunnel（Recall webhook + agent 網頁，一條搞定）
#
# 後端同一個 4000 埠同時提供 /webhooks/recall（Recall 把即時逐字稿與聊天室訊息 POST 進來）
# 與 /agent、/ws/agent（AGENT_MODE 的耳朵嘴巴），所以**一條 cloudflared quick tunnel 就夠**，
# 網址自動寫回 backend\.env：不必安裝 ngrok、不必申請帳號或固定網域、不必手動貼網址。
#
# 為什麼預設用 cloudflared 而不是 ngrok：ngrok 免費網域對「瀏覽器導覽」會插
# ERR_NGROK_6024 警告頁，bot 的雲端瀏覽器開不進 agent 網頁。ngrok 僅在沒有 cloudflared
# 時作為 webhook 的退路（那種情況下 agent 網頁無法使用，語音退回 webhook+mp3 舊路徑）。
#
# 血淚註記（2026-08-02）：先前 webhook 走 ngrok、agent 走 cloudflared 兩條隧道，
# .env 換了 ngrok 網域但機器上跑的還是舊那條，於是「語音正常、聊天室全聾」，
# 而且完全沒有錯誤訊息。改成一條之後，兩者要嘛一起通、要嘛一起不通，不會再有半死狀態。
$envFile = "$rootDir\backend\.env"
$agentModeOn = $false
if (Test-Path $envFile) {
    $modeLine = Select-String -Path $envFile -Pattern '^\s*AGENT_MODE=' | Select-Object -Last 1
    if ($modeLine -and (($modeLine.Line -replace '^\s*AGENT_MODE=', '').Trim().Trim('"') -eq 'on')) { $agentModeOn = $true }
}

# 用 .NET API 以 UTF-8(無 BOM) 讀寫：PS 5.1 的 Get/Set-Content 預設編碼會把中文註解弄壞。
function Set-EnvValue([string]$key, [string]$value) {
    if (-not (Test-Path $envFile)) { return }
    $content = [System.IO.File]::ReadAllText($envFile)
    if ($content -match "(?m)^\s*$key=") {
        $content = $content -replace "(?m)^\s*$key=.*$", "$key=`"$value`""
    } else {
        $content = $content.TrimEnd() + "`n$key=`"$value`"`n"
    }
    [System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-EnvValue([string]$key) {
    if (-not (Test-Path $envFile)) { return $null }
    $line = Select-String -Path $envFile -Pattern "^\s*$key=" | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line.Line -replace "^\s*$key=", '').Trim().Trim('"')
}

# webhook 共享密鑰：沒有就自動產生一組（純本機用途，不需要人工發明）
if (Test-Path $envFile) {
    $existingToken = Get-EnvValue 'RECALL_WEBHOOK_TOKEN'
    if (-not $existingToken) {
        $newToken = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
        Set-EnvValue 'RECALL_WEBHOOK_TOKEN' $newToken
        Write-Host "RECALL_WEBHOOK_TOKEN was empty -> generated one (written to backend\.env)." -ForegroundColor Gray
    }
}

# PATH 上找不到就退回 winget MSI 的預設安裝路徑（裝完當下的舊 shell 還沒有新 PATH）
$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredExe = if ($cloudflaredCmd) { $cloudflaredCmd.Source } else { "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cloudflaredExe)) { $cloudflaredExe = $null }

$tunnelUrl = $null
if ($cloudflaredExe) {
    if (Get-Process cloudflared -ErrorAction SilentlyContinue) {
        Write-Host "cloudflared already running; restarting to get a fresh URL..." -ForegroundColor Gray
        Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Write-Host "Starting cloudflared quick tunnel (webhook + agent page)..." -ForegroundColor Cyan
    $cfLog = "$env:TEMP\meetbot-cloudflared.log"
    if (Test-Path $cfLog) { Remove-Item $cfLog -Force -ErrorAction SilentlyContinue }
    # quick tunnel 網址印在 stderr -> 導到檔案再輪詢解析
    Start-Process -FilePath $cloudflaredExe -ArgumentList 'tunnel', '--url', 'http://localhost:4000' `
        -WindowStyle Minimized -RedirectStandardError $cfLog
    foreach ($i in 1..40) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $cfLog) {
            $m = Select-String -Path $cfLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
            if ($m) { $tunnelUrl = $m.Matches[0].Value; break }
        }
    }
    if ($tunnelUrl) {
        # backend 啟動時才讀 .env，所以這些寫入一定要在 npm start 之前完成。
        Set-EnvValue 'RECALL_WEBHOOK_URL' $tunnelUrl
        Write-Host "cloudflared started -> RECALL_WEBHOOK_URL=$tunnelUrl (written to backend\.env)" -ForegroundColor Green
        if ($agentModeOn) {
            Set-EnvValue 'AGENT_PAGE_URL' "$tunnelUrl/agent"
            Write-Host "                 -> AGENT_PAGE_URL=$tunnelUrl/agent" -ForegroundColor Green
        } else {
            Write-Host "AGENT_MODE is not 'on' -> agent page not used this run (webhook still works)." -ForegroundColor Gray
        }
    } else {
        Write-Host "Warning: cloudflared URL not detected within 20s. Chat messages and realtime transcript will NOT work this run. See $cfLog" -ForegroundColor Yellow
    }
}

if (-not $tunnelUrl) {
    # 退路：沒有 cloudflared（或它這次沒起來）才用 ngrok，且只能撐 webhook。
    if (-not $cloudflaredExe) {
        Write-Host "cloudflared not found -> falling back to ngrok for the webhook only (agent page unavailable)." -ForegroundColor Yellow
        Write-Host "Recommended: winget install Cloudflare.cloudflared  (then one tunnel covers everything, no ngrok needed)" -ForegroundColor Yellow
    }
    # 先試「明確路徑」（不依賴 PATH）：專案內 tools\，再來是 MSIX/winget 裝的 WindowsApps 位置。
    # start.bat 由 Explorer/cmd 啟動時，子 PowerShell 的 PATH 未必含 WindowsApps。
    $ngrokExe = $null
    $ngrokCandidates = @(
        (Join-Path $rootDir 'tools\ngrok.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\ngrok.exe')
    )
    foreach ($c in $ngrokCandidates) { if ($c -and (Test-Path $c)) { $ngrokExe = $c; break } }
    if (-not $ngrokExe) {
        $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
        if ($ngrokCmd) { $ngrokExe = if ($ngrokCmd.Source) { $ngrokCmd.Source } else { 'ngrok' } }
    }
    $webhookUrl = Get-EnvValue 'RECALL_WEBHOOK_URL'
    if (-not $ngrokExe) {
        Write-Host "Note: no tunnel available (neither cloudflared nor ngrok) -> chat messages and realtime transcript will not work." -ForegroundColor Yellow
    } elseif (-not $webhookUrl -or $webhookUrl -like '*trycloudflare.com*') {
        Write-Host "Note: RECALL_WEBHOOK_URL has no ngrok domain to reuse -> set it in backend\.env to your reserved ngrok domain, or install cloudflared (recommended)." -ForegroundColor Yellow
    } else {
        # 「有 ngrok 在跑」不等於「跑的是對的那條」：舊網域的 tunnel 還活著時，Recall 會 POST 到
        # 沒有隧道的網址，一切看起來正常但聊天室與逐字稿靜默失效（2026-08-02 踩過）。核對後再決定。
        $expectedHost = $null
        try { $expectedHost = ([Uri]$webhookUrl).Host } catch { }
        $publicUrls = @()
        try {
            $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
            $publicUrls = @($tunnels.tunnels | ForEach-Object { $_.public_url })
        } catch { }
        if ($expectedHost -and $publicUrls -and ($publicUrls | Where-Object { $_ -like "*$expectedHost*" })) {
            Write-Host "ngrok already running -> $webhookUrl" -ForegroundColor Green
        } else {
            if (Get-Process ngrok -ErrorAction SilentlyContinue) {
                Write-Host "ngrok is running but does not serve $expectedHost -> restarting." -ForegroundColor Yellow
                Stop-Process -Name ngrok -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            Start-Process -FilePath $ngrokExe -ArgumentList 'http', "--url=$webhookUrl", '4000' -WindowStyle Minimized
            Write-Host "ngrok started -> $webhookUrl" -ForegroundColor Green
        }
    }
}

# 7. Start backend + frontend together (Ctrl+C stops both)
Write-Host ""
Write-Host "Starting backend (port 4000) and frontend (port 3000)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Gray
Write-Host "(tunnel runs in a separate minimized window; to stop: Stop-Process -Name cloudflared,ngrok)" -ForegroundColor Gray
Write-Host ""
Set-Location $rootDir
npm start
