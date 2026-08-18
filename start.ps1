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
# --remove-orphans：清掉 compose 檔裡已不存在的服務所留下的容器（例如移除 Vexa 之後
# 還跑在背景的 meetbot-vexa-lite）。少了它，舊容器會一直活著，佔埠又讓人以為還在用。
docker compose up -d --remove-orphans
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
Set-Location "$rootDir\backend"

# 4a. 一次性遷移的前置段（移除 Vexa）。
# 沒有這一步，db push 會因為「刪掉有資料的欄位」被判定成破壞性變更而失敗，
# 而且是靜默失敗——app.users / app.user_tokens 不會被建出來，結果是登入 500、全站 401。
# 內容與理由見 backend\scripts\sql\01-pre-db-push.sql（冪等，跑過就是 no-op）。
Write-Host "Running pre-push migration (one-time, idempotent)..." -ForegroundColor Cyan
npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/01-pre-db-push.sql 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: pre-push migration failed; db push may fail next." -ForegroundColor Yellow
}

# db push 的輸出**不再吞掉**：它失敗代表整個後端不能用，
# 以前只印一行黃字 Warning 就往下走，等於把最關鍵的錯誤藏起來。
Write-Host "Applying Prisma schema (db push)..." -ForegroundColor Cyan
$pushOutput = npx prisma db push 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "prisma db push FAILED - the backend will not work until this is fixed:" -ForegroundColor Red
    $pushOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
} else {
    # 4b. 一次性遷移的後置段：把身份資料（使用者與未過期 token）從 Vexa 的 public schema
    # 搬進 app schema。不做的話，既有專案／會議會認錯擁有者（不是遺失，是錯給人）。
    # 內容與理由見 backend\scripts\sql\02-post-db-push.sql（冪等，app.users 有資料就跳過）。
    Write-Host "Migrating identity data into app schema (one-time, idempotent)..." -ForegroundColor Cyan
    $migrateOutput = npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/02-post-db-push.sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Warning: identity migration failed - existing projects may show the wrong owner:" -ForegroundColor Yellow
        $migrateOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    }
}

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

# INTERNAL_AUTH_SECRET：前端 NextAuth 登入時，拿它跟後端 /internal/token 換 authToken。
#
# 這個密鑰以前是可選的（沒設就退回 docker exec 打 vexa-lite 的 Admin API），移除 Vexa 之後
# 它是**唯一**的發 token 路徑。沒設的話失敗方式特別惡劣：NextAuth 仍然登入成功，
# 但 session 裡的 authToken 是 null，之後每個 API 呼叫都丟 "Not authenticated"，
# 畫面上看起來像「登入了但全站壞掉」，沒有任何訊息指向真正的原因。
#
# 前後端必須同值，所以這裡一次寫兩個檔（已存在的值優先沿用，不會蓋掉手動設定的）。
function Get-EnvValueFrom([string]$file, [string]$key) {
    if (-not (Test-Path $file)) { return $null }
    $line = Select-String -Path $file -Pattern "^\s*$key=" | Select-Object -Last 1
    if (-not $line) { return $null }
    $v = ($line.Line -replace "^\s*$key=", '').Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($v)) { return $null }
    return $v
}
function Set-EnvValueIn([string]$file, [string]$key, [string]$value) {
    if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
    $content = [System.IO.File]::ReadAllText($file)
    if ($content -match "(?m)^\s*$key=") {
        $content = $content -replace "(?m)^\s*$key=.*$", "$key=`"$value`""
    } else {
        $content = $content.TrimEnd() + "`n$key=`"$value`"`n"
    }
    [System.IO.File]::WriteAllText($file, $content, (New-Object System.Text.UTF8Encoding($false)))
}

$frontendEnvFile = "$rootDir\frontend\.env.local"
$authSecret = Get-EnvValueFrom $envFile 'INTERNAL_AUTH_SECRET'
if (-not $authSecret) { $authSecret = Get-EnvValueFrom $frontendEnvFile 'INTERNAL_AUTH_SECRET' }
if (-not $authSecret) {
    $authSecret = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    Write-Host "INTERNAL_AUTH_SECRET was empty -> generated one (written to backend\.env and frontend\.env.local)." -ForegroundColor Gray
}
if ((Get-EnvValueFrom $envFile 'INTERNAL_AUTH_SECRET') -ne $authSecret) {
    Set-EnvValueIn $envFile 'INTERNAL_AUTH_SECRET' $authSecret
}
if ((Get-EnvValueFrom $frontendEnvFile 'INTERNAL_AUTH_SECRET') -ne $authSecret) {
    Set-EnvValueIn $frontendEnvFile 'INTERNAL_AUTH_SECRET' $authSecret
    Write-Host "Synced INTERNAL_AUTH_SECRET into frontend\.env.local (front and back must match)." -ForegroundColor Gray
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
