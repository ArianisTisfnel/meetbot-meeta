# MeetBot — AI 會議助理

將 AI 助理「**蜜塔（Meeta）**」帶進 Google Meet：喚醒即回答、根據專案資料即時查詢、會議結束後自動生成摘要與交辦事項。

---

## 技術棧

| 層次 | 技術 |
|------|------|
| 前端 | Next.js 15（App Router）+ shadcn/ui + TanStack Query v5 |
| 後端 | Hono（Node.js 20+）|
| ORM | Prisma 5（`app` schema）|
| 資料庫 / Storage | PostgreSQL + MinIO（本機 Docker，`docker-compose` 一鍵啟動）|
| Bot 基礎設施 | Recall.ai（主要）+ Vexa-lite（失效轉移／本機 Docker，port 8056 + 8057）|
| AI / RAG | Dify（Knowledge Base + Chatflow + Workflow）|
| 認證 | NextAuth v4（Google OAuth）|

---

## 必要條件

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | 20+ | 後端 + 前端 |
| Docker Desktop | 最新穩定版 | 運行 Vexa-lite |

外部服務（需申請帳號並取得 API Key）：

| 服務 | 用途 |
|------|------|
| [Dify](https://dify.ai) | RAG Q&A + 會議摘要 Workflow |
| Google Cloud Console | Google OAuth 登入 |
| [Recall.ai](https://recall.ai)（主要 provider）+ [ngrok](https://ngrok.com) | Bot 加入會議、即時問答 webhook，設定見 [docs/13](docs/13-Recall-Failover-開發設定.md) |

> PostgreSQL 與檔案儲存（原本用 Supabase）已改為本機 Docker（Postgres + MinIO），**不需要**申請 Supabase 帳號。

---

## 快速啟動

### 第一步：啟動本機基礎設施（Postgres + MinIO + Vexa-lite）

專案根目錄的 `docker-compose.yml` 一次管理三個服務：
- **postgres**：本機資料庫，取代原本的 Supabase PostgreSQL（對外 port 用 **5433**，不是預設的 5432——很多電腦上已經有原生安裝的 Postgres 佔用 5432，用不同 port 避免衝突）
- **minio**：S3 相容的檔案儲存，取代 Supabase Storage
- **vexa-lite**：Bot 基礎設施（failover secondary provider，也用來維持 `public.users` / `api_tokens` 表供登入流程使用）

```bash
docker compose up -d
```

首次啟動會自動：建立 `meeting-materials` bucket（`minio-init`）、初始化 Vexa 的 `public` schema（`vexa-init-db`，有 marker 檔守門，之後每次 `up` 不會重跑）。

確認全部容器健康：

```bash
docker compose ps
# 應看到 meetbot-postgres / meetbot-minio / meetbot-vexa-lite 都是 Up ... (healthy)
```

> ℹ️ vexa-lite 官方 image 啟動時預設會送測試音檔驗證 `TRANSCRIPTION_SERVICE_URL`/`TOKEN`，沒有可用權杖會直接 `exit 1` 開不起來。這個專案目前 `BOT_PRIMARY_PROVIDER=recall`、用不到 Vexa 轉錄，`docker-compose.yml` 已經設 `SKIP_TRANSCRIPTION_CHECK=true` 跳過這個檢查，不用額外處理。

---

### 第二步：安裝後端相依套件

```bash
cd backend
npm install
```

---

### 第三步：設定後端環境變數

```bash
cd backend
cp .env.example .env
```

編輯 `backend/.env`，填入以下所有欄位：

```bash
# Local Postgres（docker-compose：postgres 服務，對外 port 5433）
DATABASE_URL="postgresql://meetbot:meetbot_local_dev@localhost:5433/meetbot"
# Prisma CLI 專用（db push）。本機沒有 pgbouncer，兩者可指向同一條連線字串。
DIRECT_URL="postgresql://meetbot:meetbot_local_dev@localhost:5433/meetbot"

# Local MinIO（docker-compose：minio 服務，取代 Supabase Storage）
S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="meetbot"
S3_SECRET_KEY="meetbot_local_dev"
S3_BUCKET="meeting-materials"
S3_REGION="us-east-1"

# Dify（從 Dify → Settings → API Keys 取得）
DIFY_API_BASE="https://api.dify.ai/v1"
DIFY_DATASET_API_KEY="dataset-..."      # Knowledge Base 操作
DIFY_WORKFLOW_API_KEY="app-..."         # RAG Q&A Chatflow
DIFY_SUMMARY_WORKFLOW_API_KEY="app-..."         # 檔案摘要 Workflow
DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY="app-..." # 會議摘要 Workflow
DIFY_CHATFLOW_TIMEOUT_MS=45000

# Anthropic（可選，僅用於無專案的獨立會議 Q&A fallback）
ANTHROPIC_API_KEY="sk-ant-..."

# Vexa（需與 docker-compose 的 vexa-lite 一致）
VEXA_API_URL="http://localhost:8056"
VEXA_WS_URL="ws://localhost:8056"
# vexa-lite 容器自身設定，透過 docker-compose env_file 傳入該容器。
# ADMIN_API_TOKEN 需與 frontend/.env.local 的 VEXA_ADMIN_API_KEY 同值。
ADMIN_API_TOKEN="my-local-admin-token-2026"
# 跟 Vexa 官方申請；沒有的話留空也能開機（見上方 SKIP_TRANSCRIPTION_CHECK 說明）。
TRANSCRIPTION_SERVICE_URL="https://transcription.vexa.ai/v1/audio/transcriptions"
TRANSCRIPTION_SERVICE_TOKEN="vxa_tx_..."

# Server
APP_PORT=4000
APP_CORS_ORIGINS="http://localhost:3000"
APP_BASE_URL="http://localhost:3000"   # 用於組出專案邀請的接受連結

# 寄信（專案邀請信）— 全部可選。未設定時邀請仍可建立，接受連結會印在 backend log，
# 邀請對話框也會顯示可複製的連結，只是不會真的寄出 email。
# 用 Gmail 寄信：先對「你自己的」Gmail 開啟兩步驟驗證，再到
# https://myaccount.google.com/apppasswords 產生 16 碼應用程式密碼（填 SMTP_PASS，去除空格）。
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER="your-own@gmail.com"
SMTP_PASS="your16charapppassword"
MAIL_FROM="your-own@gmail.com"
INVITATION_TTL_DAYS=7   # 邀請連結有效天數
```

---

### 第四步：初始化資料庫 Schema

首次執行需要同步 Prisma schema 至本機 Postgres：

```bash
cd backend
npx prisma db push
```

> ℹ️ 這會在本機 Postgres 建立 `app` schema 的所有表格（`projects`、`project_members`、`materials`、`meeting_instances` 等）。Vexa 管理的 `public` schema（由第一步的 `vexa-init-db` 建立）**不受影響**。
>
> ⚠️ 每個人現在都是**自己的本機資料庫**（不像 Supabase 是全組共用），這一步**每個人都要自己執行一次**，不是做過一次就好。

---

### 第五步：啟動後端

```bash
cd backend
npm run dev
```

正常啟動後應看到：

```
{"msg":"Indexing poller started (interval: 30s)"}
{"msg":"startup restore completed"}
{"msg":"meetbot backend started on port 4000"}
```

---

### 第六步：安裝前端相依套件

```bash
cd frontend
npm install
```

---

### 第七步：設定前端環境變數

```bash
cd frontend
# 建立 .env.local（不入版控）
```

建立 `frontend/.env.local`，填入：

```bash
# 後端 API
NEXT_PUBLIC_API_URL="http://localhost:4000"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="<自訂一個隨機字串，本地開發任意值即可>"

# Vexa Admin（需與 docker run 的 ADMIN_API_TOKEN 相同）
VEXA_API_URL="http://localhost:8056"
VEXA_ADMIN_API_URL="http://localhost:8057"
VEXA_ADMIN_API_KEY="my-local-admin-token-2026"

# Google OAuth（從 Google Cloud Console → OAuth 2.0 用戶端 ID 取得）
GOOGLE_CLIENT_ID="<YOUR_GOOGLE_CLIENT_ID>"
GOOGLE_CLIENT_SECRET="<YOUR_GOOGLE_CLIENT_SECRET>"
```

**Google OAuth 設定**：在 Google Cloud Console 的「已授權的重新導向 URI」加入：
```
http://localhost:3000/api/auth/callback/google
```

---

### 第八步：啟動前端

```bash
cd frontend
npm run dev
```

正常啟動後應看到：

```
▲ Next.js 15.3.x
- Local: http://localhost:3000
✓ Ready in ...s
```

---

## 每日啟動（環境設定完成後）

首次設定完成後，之後每次開機只需：

**方法一（雙擊）**：直接雙擊專案根目錄的 `start.bat`

**方法二（終端）**：
```bash
# 1. 確認 Docker Desktop 已開啟，然後啟動本機基礎設施
docker compose up -d

# 2. 在專案根目錄同時啟動前後端（Ctrl+C 一次全停）
npm start
```

`npm start` 使用 `concurrently` 在同一個視窗以彩色 log 同時跑後端（port 4000）與前端（port 3000）。

---

## 拉取他人更新後（git pull 之後）

- **用 `start.ps1` / `start.bat` 啟動的人**：什麼都不用做。它會自動 `npm install`（backend + frontend）和 `npx prisma generate`，新相依套件會自動補上。
- **手動 `npm run dev` 的人**：若這次更新有新增套件或改動 `schema.prisma`，記得：
  ```bash
  cd backend && npm install && npx prisma generate
  cd ../frontend && npm install
  ```
- **資料庫**：現在每個人都是**自己的本機 Postgres**（不是共用 Supabase），`schema.prisma` 有變更時**每個人都要自己**跑一次 `cd backend && npx prisma db push`，不是任一人 push 過就好。

---

## 驗證一切正常

打開瀏覽器前，先確認後端 API 可存取（應回傳 401，代表 auth middleware 正常）：

```bash
curl http://localhost:4000/health
# {"error_code":"UNAUTHORIZED","message":"缺少 Authorization header"}
```

接著打開 [http://localhost:3000](http://localhost:3000)，應跳轉至登入頁，點選「使用 Google 帳號登入」完成認證。

---

## 執行測試

```bash
# 從專案根目錄執行所有單元測試
npx vitest run

# 預期結果：
# Test Files  16 passed (16)
#      Tests  105 passed (105)
```

---

## 常用指令速查

```bash
# 前後端同時啟動（推薦，Ctrl+C 一次全停）
npm start

# 後端單獨啟動
cd backend && npm run dev

# 前端單獨啟動
cd frontend && npm run dev

# 單元測試（根目錄）
npx vitest run

# Prisma schema 同步（schema.prisma 有變更時）
cd backend && npx prisma db push

# 查看本機基礎設施容器狀態（postgres / minio / vexa-lite）
docker compose ps

# 查看 Vexa 用戶列表（確認 admin API 正常）
docker exec meetbot-vexa-lite curl -s -H "X-Admin-API-Key: my-local-admin-token-2026" http://localhost:8057/admin/users
```

> 資料庫瀏覽 / 查詢方式（Prisma Studio、psql、GUI 工具連線資訊）見下方「[資料庫管理](#資料庫管理)」。

---

## 資料庫管理

Supabase 原本有網頁版的 Table Editor；換成本機 Postgres 後，依需求選一種：

### 方法一：Prisma Studio（推薦，零額外設定）

```bash
cd backend && npx prisma studio
```

開啟網頁 GUI（預設 `http://localhost:5555`），可瀏覽/編輯這個專案自己的資料表（`projects`、`meetings`、`materials` 等，即 `app` schema）。**限制**：看不到 Vexa 管理的 `public` schema（`users`、`api_tokens` 等）。

### 方法二：psql（指令列，涵蓋所有 schema）

```bash
docker exec -it meetbot-postgres psql -U meetbot -d meetbot
```

進去後 `\dt app.*` 看這個專案的表，`\dt public.*` 看 Vexa 的表。

### 方法三：桌面 GUI 工具（DBeaver、TablePlus、pgAdmin 等）

用以下資訊連線：

| 欄位 | 值 |
|------|-----|
| Host | `localhost` |
| Port | `5433` |
| User | `meetbot` |
| Password | `meetbot_local_dev` |
| Database | `meetbot` |

### 檔案儲存（MinIO，取代 Supabase Storage）

開瀏覽器 **http://localhost:9001**（帳密 `meetbot` / `meetbot_local_dev`），可以瀏覽上傳的會議資料檔案與逐字稿。

---

## 目錄結構

```
meetbot/
├── backend/              # Hono 後端 API
│   ├── src/
│   │   ├── routes/       # API 路由
│   │   ├── services/     # 業務邏輯（project / member / invitation / material / meeting）
│   │   ├── sessions/     # Bot Session 管理（WebSocket + 喚醒詞 + 摘要）
│   │   ├── lib/          # 外部服務封裝（dify / storage(S3) / vexa / prisma / email）
│   │   ├── middleware/   # auth / logger / error-handler
│   │   └── types/        # env schema、hono context type
│   └── prisma/
│       └── schema.prisma # app schema 定義
├── frontend/             # Next.js 15 前端
│   └── src/
│       ├── app/          # App Router 頁面
│       ├── components/   # UI 元件（shadcn/ui 精簡版 + 自訂元件）
│       ├── hooks/        # TanStack Query 自訂 Hook
│       ├── lib/          # API client、auth 設定
│       └── types/        # API Response 型別
├── tests/
│   ├── unit/             # Vitest 單元測試
│   └── mocks/            # 外部服務 mock
├── docs/                 # 設計文件（需求 / Schema / API / 前端 / 後端架構）
└── docker-compose.yml    # 本機基礎設施：postgres / minio / vexa-lite
```

---

## 關鍵設計說明

### 雙 Schema 架構

```
public schema  ← Vexa-lite 管理，只讀。使用 prisma.$queryRaw 存取
app schema     ← 我們管理，Prisma 控制
```

跨 schema 關聯以整數邏輯 FK（`vexa_user_id`、`vexa_meeting_id`）記錄，無 DB constraint。

### Bot Session 生命週期

1. `POST /meetings/:id/bot` → 呼叫 Vexa API 建立 Bot，DB 狀態維持 `PENDING`
2. Vexa WS 送來 `{type:"meeting.status", payload:{status:"active"}}` → DB 轉 `ACTIVE`
3. 喚醒詞（`蜜塔` / `小幫手`）偵測 → 查詢 Dify Chatflow → TTS 回覆
4. WS 連線關閉 → 觸發摘要生成 → DB 轉 `ENDED`

### 摘要 Sentinel 值

| `summary` 欄位值 | 意義 |
|-----------------|------|
| `null` | 摘要尚未生成（前端繼續輪詢） |
| `''`（空字串） | 已嘗試但無內容（前端停止輪詢） |
| 字串內容 | 正常摘要 |
