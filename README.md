# MeetBot — AI 會議助理

將 AI 助理「**蜜塔（Meeta）**」帶進 Google Meet：喚醒即回答、根據專案資料即時查詢、會議結束後自動生成摘要與交辦事項。

---

## 技術棧

| 層次 | 技術 |
|------|------|
| 前端 | Next.js 15（App Router）+ shadcn/ui + TanStack Query v5 |
| 後端 | Hono（Node.js 20+）|
| ORM | Prisma 5（`app` schema）|
| 資料庫 / Storage | Supabase（PostgreSQL + Storage）|
| Bot 基礎設施 | Vexa-lite（Docker，port 8056 + 8057）|
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
| [Supabase](https://supabase.com) | PostgreSQL + Storage |
| [Dify](https://dify.ai) | RAG Q&A + 會議摘要 Workflow |
| Google Cloud Console | Google OAuth 登入 |

---

## 快速啟動

### 第一步：啟動 Vexa-lite

Vexa-lite 是 Bot 的核心基礎設施，必須最先啟動。使用以下 `docker run` 指令（請替換 `<YOUR_DB_URL>` 為你的 Supabase DATABASE_URL）或直接執行`00-vexa-lite-local.md`內的指令：

```bash
docker run \
  --env=ADMIN_API_TOKEN=my-local-admin-token-2026 \
  --env=DATABASE_URL=<YOUR_DB_URL> \
  --env=TRANSCRIPTION_SERVICE_URL=https://transcription.vexa.ai/v1/audio/transcriptions \
  --env=TRANSCRIPTION_SERVICE_TOKEN=<YOUR_VEXA_TX_TOKEN> \
  --env=OPENAI_API_KEY=<YOUR_OPENAI_KEY> \
  --env=VEXA_API_URL=http://localhost:8056 \
  --env=ADMIN_API_URL=http://localhost:8057 \
  --env=ORCHESTRATOR_BACKEND=process \
  --env=STORAGE_BACKEND=local \
  --env=LOCAL_STORAGE_DIR=/var/lib/vexa/recordings \
  -p 8056:8056 \
  -p 8057:8057 \
  -d vexaai/vexa-lite:latest
```

> ⚠️ 必須同時映射 **8056**（Bot API）與 **8057**（Admin API）兩個 port，NextAuth 登入流程需要存取 Admin API。

初次啟動後，執行一次 DB 初始化（之後不需要再執行）：

```bash
docker exec <CONTAINER_ID> python3 -c "import asyncio; from admin_models.database import init_db; asyncio.run(init_db())"
docker exec <CONTAINER_ID> python3 -c "import asyncio; from meeting_api.database import init_db; asyncio.run(init_db())"
```

確認容器正常運行：

```bash
docker ps
# 應看到 STATUS: Up ... (healthy)，PORTS: 0.0.0.0:8056->8056, 0.0.0.0:8057->8057
```

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
# Supabase（從 Supabase Dashboard → Settings → Database 取得）
DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
SUPABASE_URL="https://<PROJECT_REF>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE_KEY>"   # Settings → API → service_role
SUPABASE_STORAGE_BUCKET="meeting-materials"

# Dify（從 Dify → Settings → API Keys 取得）
DIFY_API_BASE="https://api.dify.ai/v1"
DIFY_DATASET_API_KEY="dataset-..."      # Knowledge Base 操作
DIFY_WORKFLOW_API_KEY="app-..."         # RAG Q&A Chatflow
DIFY_SUMMARY_WORKFLOW_API_KEY="app-..."         # 檔案摘要 Workflow
DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY="app-..." # 會議摘要 Workflow
DIFY_CHATFLOW_TIMEOUT_MS=45000

# Anthropic（可選，僅用於無專案的獨立會議 Q&A fallback）
ANTHROPIC_API_KEY="sk-ant-..."

# Vexa（與 docker run 的 ADMIN_API_TOKEN 相同）
VEXA_API_URL="http://localhost:8056"
VEXA_WS_URL="ws://localhost:8056"

# Server
APP_PORT=4000
APP_CORS_ORIGINS="http://localhost:3000"
```

---

### 第四步：初始化資料庫 Schema

首次執行需要同步 Prisma schema 至 Supabase：

```bash
cd backend
npx prisma db push
```

> ℹ️ 這會在 Supabase 建立 `app` schema 的所有表格（`projects`、`project_members`、`materials`、`meeting_instances` 等）。Vexa 管理的 `public` schema **不受影響**。

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
# Test Files  14 passed (14)
#      Tests  91 passed (91)
```

---

## 常用指令速查

```bash
# 後端開發啟動
cd backend && npm run dev

# 前端開發啟動
cd frontend && npm run dev

# 單元測試（根目錄）
npx vitest run

# Prisma schema 同步（schema.prisma 有變更時）
cd backend && npx prisma db push

# 查看 Vexa-lite 容器狀態
docker ps

# 查看 Vexa 用戶列表（確認 admin API 正常）
docker exec <CONTAINER_ID> curl -s -H "X-Admin-API-Key: my-local-admin-token-2026" http://localhost:8057/admin/users
```

---

## 目錄結構

```
meetbot/
├── backend/              # Hono 後端 API
│   ├── src/
│   │   ├── routes/       # API 路由
│   │   ├── services/     # 業務邏輯（project / material / meeting）
│   │   ├── sessions/     # Bot Session 管理（WebSocket + 喚醒詞 + 摘要）
│   │   ├── lib/          # 外部服務封裝（dify / supabase / vexa / prisma）
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
└── docs/                 # 設計文件（需求 / Schema / API / 前端 / 後端架構）
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
