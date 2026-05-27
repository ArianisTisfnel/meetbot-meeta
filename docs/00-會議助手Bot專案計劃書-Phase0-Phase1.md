# 會議助手 Bot 專案計劃書

## Phase 0 – 可行性驗證 + Phase 1 – 資料管理基礎

|項目   |內容                             |
|-----|-------------------------------|
|文件版本 |v1.0                           |
|撰寫日期 |2026-05-17                     |
|涵蓋範圍 |Phase 0(可行性驗證)、Phase 1(資料管理基礎) |
|預估總時程|Phase 0: 4-6 天 / Phase 1: 5-6 天|

-----

## 目錄

1. [專案概述](#1-專案概述)
1. [專案目標與動機](#2-專案目標與動機)
1. [使用者流程](#3-使用者流程)
1. [整體系統架構](#4-整體系統架構)
1. [技術選型](#5-技術選型)
1. [Phase 0：可行性驗證](#6-phase-0可行性驗證)
1. [Phase 1：資料管理基礎](#7-phase-1資料管理基礎)
1. [後續 Phase 概覽](#8-後續-phase-概覽)
1. [整體風險與緩解策略](#9-整體風險與緩解策略)
1. [參考資料](#10-參考資料)

-----

## 1. 專案概述

本專案開發一個可加入 Google Meet 的會議助手 Bot。Bot 在會議進行中監聽喚醒詞「小幫手」，並根據預先上傳的會議資料（如內部組織規則、技術文件等）即時回答會議參與者的問題。Bot 的回覆方式會根據提問來源自動切換：

- **使用者在 Meet 聊天室輸入提問** → Bot 在聊天室以文字回覆
- **使用者以語音提問** → Bot 以語音回覆

系統整合既有開源工具（Vexa-lite、Dify、Supabase），降低自行開發底層元件的成本，將開發資源聚焦在使用者價值上。

-----

## 2. 專案目標與動機

### 2.1 目標

|目標    |描述                                          |
|------|--------------------------------------------|
|核心功能目標|會議 Bot 加入 Google Meet，被呼叫時可即時根據預先儲存的會議資料回答問題|
|文件目標  |計劃書讓指導老師與專案同學對專案架構與細節有清楚認知                  |

### 2.2 動機

許多會議中參與者會臨時想查詢內部規則、流程或既有文件，傳統作法需要會議中斷、開啟其他工具搜尋。本專案提供一個「在會議裡就能即時被詢問」的助手，提升會議效率並降低資訊查找的摩擦。

-----

## 3. 使用者流程

完整的使用者流程包含以下六個步驟：

1. **上傳會議資料**：使用者上傳會議相關文件（例如內部組織規則、會議手冊、技術規格書等）
1. **管理會議資料**：檢視已上傳清單、刪除單份資料
1. **建立會議並加入 Bot**：使用者建立會議紀錄，並指派 Bot 加入指定的 Google Meet
1. **即時監看會議**：透過 dashboard 查看會議的即時逐字稿、Bot 狀態
1. **透過喚醒詞「小幫手」提問**：在會議中使用聊天室或語音呼叫 Bot 提問
1. **主動讓 Bot 離開會議**：會議結束時手動結束 Bot 會話

-----

## 4. 整體系統架構

### 4.1 高階架構圖

```
                              瀏覽器
                                 │
                                 ▼
        ┌────────────────────────────────────────────┐
        │  Forked Vexa Dashboard (Next.js, :3000)    │
        │  ┌──────────────┐  ┌──────────────────┐   │
        │  │ Vexa 原生頁面 │  │ Materials 管理頁  │   │
        │  │ - 會議管理    │  │ - 資料上傳        │   │
        │  │ - 即時逐字稿  │  │ - 清單與刪除      │   │
        │  └──────┬───────┘  └────────┬─────────┘   │
        │         │ 共用 NextAuth      │             │
        └─────────┼───────────────────┼─────────────┘
                  │                   │
                  ▼                   ▼
        ┌──────────────────┐  ┌─────────────────────┐
        │  Vexa-lite API   │  │  App Backend        │
        │  (Vexa 容器)      │  │  Hono + Prisma      │
        │  :8056           │  │  :4000              │
        │                  │  │  - Materials CRUD   │
        │  - Bot 控制       │  │  - 權限驗證          │
        │  - 轉錄串流       │  │  - Dify 整合         │
        │  - Interactive   │  │                     │
        │    (speak/chat)  │  │                     │
        └────────┬─────────┘  └───────┬─────────────┘
                 │                    │
                 │                    ├─────► Dify (RAG)
                 │                    │
                 └──────────┬─────────┘
                            ▼
              ┌──────────────────────────┐
              │   Supabase Postgres      │
              │  ┌──────────┬─────────┐  │
              │  │  public  │  app    │  │
              │  │ (Vexa)   │ (App)   │  │
              │  └──────────┴─────────┘  │
              │                          │
              │   Supabase Storage       │
              │   - meeting-materials    │
              └──────────────────────────┘
                            ▲
                            │
                            ▼
              ┌──────────────────────────┐
              │   Google Meet            │
              │   (Bot 加入會議)          │
              └──────────────────────────┘
```

### 4.2 元件職責對應

|元件                   |來源              |主要職責                              |
|---------------------|----------------|----------------------------------|
|Forked Vexa Dashboard|Vexa 開源專案 fork  |使用者介面、認證、會議監看、資料管理                |
|App Backend          |自行開發            |Materials CRUD、權限驗證、整合 Dify       |
|Vexa-lite            |Vexa 開源專案       |Bot 控制、Google Meet 加入、即時轉錄、語音/聊天互動|
|Dify                 |SaaS / Self-host|RAG 工作流、Knowledge Base 索引、向量搜尋    |
|Supabase Postgres    |SaaS            |結構化資料儲存（schema 分離設計）              |
|Supabase Storage     |SaaS            |原始檔案儲存                            |

-----

## 5. 技術選型

### 5.1 後端技術棧

|項目            |選擇                   |理由                              |
|--------------|---------------------|--------------------------------|
|Runtime       |Node.js 20 LTS       |與 Vexa Dashboard 同生態，方便共用認證機制   |
|Framework     |Hono                 |輕量、原生 TypeScript 支援、效能優異        |
|ORM           |Prisma（multiSchema）  |型別安全、支援跨 schema、生態成熟            |
|驗證            |Zod                  |與 TypeScript 整合最佳、可從 schema 推導型別|
|Storage Client|@supabase/supabase-js|官方 SDK                          |
|認證            |NextAuth JWT 共用      |與 Vexa Dashboard 同 secret 互通    |

### 5.2 前端策略

採用 **「Fork Vexa Dashboard + 新增頁面」** 的整合策略：

- 直接保留 Vexa Dashboard 既有功能（會議管理、即時逐字稿、使用者管理）
- 新增 `/materials` 路由處理資料管理
- 共用 NextAuth session 達成統一認證
- Materials 頁面呼叫獨立的 App Backend（不寫成 Next.js API Routes，保留 Backend 獨立性）

### 5.3 資料庫架構：Schema 分離

Vexa-lite 啟動時會自動 migrate 自己的 schema 到 Postgres。為避免衝突與便於維護，採用 schema 分離設計：

```
Supabase Postgres
├── schema: public            ← Vexa-lite 自動管理（不要修改）
│   ├── meetings
│   ├── transcripts
│   ├── users
│   └── ...
│
└── schema: app               ← 應用獨立管理（Prisma migrate）
    ├── materials
    ├── meeting_sessions      (Phase 2 新增)
    └── qa_logs               (Phase 3 新增)
```

**重要原則**：

- 跨 schema 不建立外鍵約束，僅以 ID 做邏輯關聯
- App 對 `public` schema 採「只讀」模式
- Vexa schema 透過 `prisma db pull` 同步定義，不手動維護

-----

## 6. Phase 0：可行性驗證

### 6.1 Phase 0 目標

在投入 Phase 1-3 大量開發前，先用 4-6 天時間驗證 5 個關鍵技術假設。每個 PoC 都有明確的「通過 / 失敗」標準。任何 PoC 失敗都會觸發架構調整討論。

### 6.2 為何需要 Phase 0

|驗證點                |風險來源                                       |
|-------------------|-------------------------------------------|
|Chat 雙向溝通          |Vexa 文件雖標示支援，需實際驗證中文聊天室、延遲表現               |
|語音雙向溝通             |TTS 需 OpenAI API key、PulseAudio 容器設定，需確認可運作|
|中文喚醒詞辨識            |Vexa 預設模型對中文「小幫手」的辨識準確率未知                  |
|Dify 串接            |Dify 工作流需配合語音輸出設計回覆長度與格式                   |
|Vexa Dashboard Fork|新增頁面、共用 NextAuth、跨服務 CORS 等整合性問題           |

### 6.3 PoC A：Chat 提問偵測與回覆（2 天）

**目標**：使用者在 Meet 聊天室打「小幫手 XXX」，Bot 在聊天室回覆固定文字「我收到了」

**步驟**：

1. 部署 Vexa-lite 容器（依官方 Vexa Lite Deployment 文件）
1. 啟動 Bot 加入測試 Meet
1. 建立 WebSocket 連線，監聽 `chat.received` 事件
1. 偵測到「小幫手」開頭的訊息時，呼叫 `POST /bots/{platform}/{meeting_id}/chat` 回覆
1. 記錄端對端延遲

**驗收標準**：

- `chat.received` 事件能正確回傳 sender、text、timestamp
- Bot 能成功在 Meet chat 顯示回覆文字
- 端對端延遲 < 5 秒（不含 RAG，純 echo 回覆）

### 6.4 PoC B：語音提問偵測與語音回覆（2 天）

**目標**：使用者說「小幫手 XXX」，Bot 用語音回覆固定文字「我收到了」

**步驟**：

1. 確認 Vexa Transcription API 有在 webhook / stream 回傳文字
1. 偵測到轉錄文字中出現「小幫手」時，呼叫 `POST /bots/.../speak`
1. 監聽 `speak.started` / `speak.completed` WebSocket 事件確認播放完畢
1. 確認 `OPENAI_API_KEY` 在 docker-compose 環境變數設定正確
1. 記錄端對端延遲

**驗收標準**：

- Vexa 轉錄能正確辨識中文「小幫手」喚醒詞
- 會議參與者聽得到 Bot 的語音
- 端對端延遲 < 8 秒（轉錄 + TTS 合理延遲）
- `speak.completed` 事件正常觸發，沒有語音重疊問題

### 6.5 PoC C：提問來源路由（1 天）

**目標**：整合 PoC A + B，根據提問來源自動選擇回覆管道

**步驟**：

1. 建立統一的訊息處理函式 `handleQuery(source, text)`
- `source = "chat"` → 呼叫 chat API 回覆
- `source = "voice"` → 呼叫 speak API 回覆
1. 測試兩種情境都能正確路由
1. 處理 edge case：語音與聊天同時觸發時的優先順序

**驗收標準**：

- Chat 提問 → 只在 chat 回覆（不會觸發語音）
- 語音提問 → 只用語音回覆（不會觸發 chat）
- 邊界情境有明確處理邏輯與文件紀錄

### 6.6 PoC D：Dify RAG 整合（1 天）

**目標**：把固定回覆「我收到了」換成真正呼叫 Dify workflow 取得答案

**步驟**：

1. 在 Dify 建立測試 Knowledge Base，上傳一份測試文件（例如公司規則 PDF）
1. 建立 RAG workflow，接收問題、回傳答案
1. 在 `handleQuery` 中先呼叫 Dify API 取得答案，再依 source 回覆
1. 測試「文件有答案」與「文件沒答案」兩種情境

**驗收標準**：

- Dify 正確從文件中找到答案
- 答案長度適合語音播報（建議透過 Dify prompt 控制在 100 字以內）
- 無答案時有合理的 fallback 回覆

### 6.7 PoC E：Vexa Dashboard Fork 驗證（0.5-1 天）

**目標**：驗證 Vexa Dashboard 可以順利 fork、新增頁面、與獨立 Backend 整合

**步驟**：

1. Clone Vexa Dashboard，本機跑起來，連到本機 vexa-lite
1. 加一個簡單的 `/test-materials` 頁面，驗證能順利新增路由
1. 確認 NextAuth session 在新頁面可正常使用
1. 從新頁面呼叫一個外部 API（模擬未來的 Hono backend），驗證 CORS 與 auth header 流通
1. 確認 `NEXTAUTH_SECRET` 可以分享給 Hono backend 用來驗 JWT

**驗收標準**：

- Fork 後可以順利新增頁面
- NextAuth session 在新頁面可拿到 `user.id` 與 `role`（或確認需自建 role）
- Hono backend 可用 NextAuth 的 JWT secret 驗 token

### 6.8 Phase 0 時程

|天數      |任務                             |
|--------|-------------------------------|
|Day 1-2 |PoC A (Chat 讀寫)                |
|Day 3-4 |PoC B (語音輸出)                   |
|Day 5 上午|PoC C (路由邏輯)                   |
|Day 5 下午|PoC D (串接 Dify)                |
|Day 6   |PoC E (Dashboard Fork) + buffer|

### 6.9 Phase 0 風險與備案

|風險                       |發生機率|備案                                                 |
|-------------------------|----|---------------------------------------------------|
|中文「小幫手」轉錄準確率低            |中   |改用英文喚醒詞 “assistant”，或在 Vexa 設定指定語言                 |
|語音延遲 > 10 秒，體驗差          |中   |先播一句「好的，我來查一下」(< 1 秒)，降低等待感                        |
|TTS 中文語音品質差              |中   |測試 OpenAI TTS 不同 voice (nova / alloy / shimmer)，選最佳|
|語音重疊（無 speech queue）     |中   |加 `isSpeaking` flag，說話中的新提問放入 queue                |
|Vexa Dashboard 沒有 role 概念|中   |自建 `user_roles` 表                                  |
|Fork 後遇到難解 bug           |低   |退回到「Dashboard 不改 + 獨立 Materials App」方案             |

### 6.10 Phase 0 完成標準（彙整 Checklist）

```
PoC A：Chat 雙向
  □ chat.received WebSocket 可拿到 sender/text/timestamp
  □ Bot 能寫入 Meet chat

PoC B：語音雙向
  □ 中文「小幫手」可被轉錄辨識
  □ Bot 語音能被聽見
  □ speak.completed 事件正常

PoC C：路由
  □ Chat 提問 → Chat 回覆
  □ 語音提問 → 語音回覆
  □ Edge case 有文件記錄

PoC D：RAG
  □ Dify 能正確回答文件中的問題
  □ 答案長度適合語音播報

PoC E：Dashboard Fork
  □ 可新增頁面
  □ NextAuth session 可取得
  □ 跨服務 JWT 驗證可行

整體
  □ 各環節實際延遲數字有記錄
  □ 通過的 PoC 有 demo 影片或截圖（給計劃書用）
```

-----

## 7. Phase 1：資料管理基礎

### 7.1 Phase 1 目標

完成後可以做到：

1. 在 web 介面（Forked Vexa Dashboard）上拖拉上傳 PDF / DOCX / TXT / MD 檔案
1. 看到上傳的檔案在 Supabase Storage 與 Dify Knowledge Base 都正確存在
1. 在管理頁可以檢視清單、查看索引狀態、刪除單份檔案
1. 不同角色（Admin / User）有不同的操作權限
1. 在 Dify chat 介面直接用上傳的資料測試 RAG 問答（驗證資料是好的）

### 7.2 Phase 1 任務拆解

#### 模組 1：Supabase 與 Vexa-lite 環境建置（0.5 天）

|任務                    |說明                                                          |
|----------------------|------------------------------------------------------------|
|1.1 建立 Supabase 專案    |Cloud free tier 即可                                          |
|1.2 啟動 Vexa-lite 容器   |讓它先 migrate `public` schema                                 |
|1.3 確認 Vexa schema 完成 |不要修改                                                        |
|1.4 建立 `app` schema   |`CREATE SCHEMA IF NOT EXISTS app;`                          |
|1.5 設定 search_path 與權限|App 使用者只能寫 `app` schema                                     |
|1.6 建立 Storage bucket |`meeting-materials`，private                                 |
|1.7 取得連線資訊            |`DATABASE_URL` (含 `?schema=app`)、`SUPABASE_SERVICE_ROLE_KEY`|

#### 模組 2：Dify 環境建置（0.5 天）

|任務                   |說明                                     |
|---------------------|---------------------------------------|
|2.1 註冊 / 部署 Dify     |建議 Cloud 版                             |
|2.2 建立 Knowledge Base|命名 `meeting-materials`                 |
|2.3 設定 embedding     |建議 OpenAI `text-embedding-3-small`     |
|2.4 設定 retrieval     |Hybrid search (語義 + 關鍵字)               |
|2.5 設定 chunking      |Chunk size 500 tokens、overlap 50 tokens|
|2.6 取得 API 資訊        |`DIFY_API_KEY`、`DIFY_DATASET_ID`       |

#### 模組 3：Backend Hono API（2 天）

|任務                         |說明                                    |
|---------------------------|--------------------------------------|
|3.1 專案初始化                  |Hono + TypeScript + Prisma multiSchema|
|3.2 Prisma schema 定義       |詳見 7.3 節                              |
|3.3 Auth middleware        |驗證 NextAuth JWT                       |
|3.4 Role middleware        |`requireRole("ADMIN")`                |
|3.5 `POST /materials`      |上傳：含 SHA-256 判重、rollback 邏輯           |
|3.6 `GET /materials`       |列表：User 看自己的、Admin 看全部                |
|3.7 `DELETE /materials/:id`|刪除：權限檢查、三方資料同步刪除                      |
|3.8 Background polling     |定期同步 Dify indexing status             |
|3.9 共用：logging、錯誤處理        |統一錯誤格式                                |

#### 模組 4：Frontend Fork Vexa Dashboard（2 天）

|任務                     |說明                                      |
|-----------------------|----------------------------------------|
|4.1 Fork Vexa Dashboard|到自己的 repo                               |
|4.2 跑起來確認原功能           |連到本機 vexa-lite 確認可用                     |
|4.3 加入路由               |`/materials`（清單）、`/materials/upload`（上傳）|
|4.4 加入導覽連結             |在 sidebar 加 Materials 入口                |
|4.5 串接 Backend API     |透過 NextAuth JWT 認證                      |
|4.6 角色相關 UI            |顯示上傳者；Admin 看全部、User 看自己                |

#### 模組 5：整合與測試（0.5 天）

|任務           |說明                |
|-------------|------------------|
|5.1 端對端測試    |上傳 → 三方資料同步驗證     |
|5.2 權限測試     |User 不能刪 Admin 上傳的|
|5.3 異常測試     |大檔、不支援格式、重複檔案     |
|5.4 Fork 回歸測試|Vexa 原功能仍正常       |
|5.5 Demo 影片錄製|供計劃書與報告使用         |

### 7.3 資料庫設計（Prisma Schema）

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["app", "public"]
}

// ============================================
// app schema：應用獨立管理
// ============================================

model Material {
  id                String    @id @default(uuid())
  filename          String
  displayName       String    @map("display_name")
  sizeBytes         BigInt    @map("size_bytes")
  mimeType          String    @map("mime_type")
  sha256            String    @unique
  storagePath       String    @map("storage_path")
  difyDatasetId     String    @map("dify_dataset_id")
  difyDocumentId    String?   @map("dify_document_id")
  indexingStatus    IndexingStatus @default(PENDING) @map("indexing_status")
  indexingError     String?   @map("indexing_error")
  uploadedByUserId  String    @map("uploaded_by_user_id")  // 跨 schema 邏輯關聯
  uploadedAt        DateTime  @default(now()) @map("uploaded_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")
  deletedAt         DateTime? @map("deleted_at")

  @@index([uploadedAt(sort: Desc)])
  @@index([indexingStatus])
  @@index([uploadedByUserId])
  @@map("materials")
  @@schema("app")
}

enum IndexingStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED

  @@map("indexing_status")
  @@schema("app")
}

// ============================================
// public schema：透過 `prisma db pull` 自動同步 Vexa 表定義
// ============================================
```

**取得 Vexa schema 的步驟**：

```bash
# 1. 啟動 Vexa-lite 讓它建好 public schema
docker compose up -d vexa-lite

# 2. 用 prisma db pull 自動同步 schema 定義
npx prisma db pull
# 會把 public schema 表定義自動加進 schema.prisma
# 保留需要的（如 User），刪除用不到的

# 3. 後續 app schema 的變更用 migrate
npx prisma migrate dev --name add_materials_table
```

### 7.4 API 規格

#### POST /materials

```
Headers:
  Authorization: Bearer <NextAuth JWT>
  Content-Type: multipart/form-data

Request body:
  file: <binary>
  display_name?: string

Response 201:
{
  "id": "uuid",
  "filename": "rules.pdf",
  "display_name": "公司規則 v2",
  "size_bytes": 1234567,
  "mime_type": "application/pdf",
  "indexing_status": "processing",
  "uploaded_by_user_id": "uuid",
  "uploaded_at": "2026-05-17T10:00:00Z"
}

Response 409 (重複檔案):
{
  "error_code": "DUPLICATE_FILE",
  "message": "This file has already been uploaded",
  "details": { "existing_material_id": "uuid" }
}

Response 413 (檔案過大):
{
  "error_code": "FILE_TOO_LARGE",
  "message": "File size exceeds 15 MB limit"
}
```

#### GET /materials

```
Headers:
  Authorization: Bearer <NextAuth JWT>

行為：
  - 一般 User：只回傳自己上傳的（uploaded_by_user_id = current user）
  - Admin：回傳全部

Response 200:
{
  "items": [
    {
      "id": "uuid",
      "display_name": "公司規則 v2",
      "size_bytes": 1234567,
      "indexing_status": "completed",
      "uploaded_by_user_id": "uuid",
      "uploaded_at": "..."
    }
  ],
  "total": 5
}
```

#### DELETE /materials/:id

```
Headers:
  Authorization: Bearer <NextAuth JWT>

權限：
  - 一般 User：只能刪自己上傳的
  - Admin：可刪任何

Response 204: (no body)

Response 403:
{ "error_code": "FORBIDDEN", "message": "Cannot delete others' materials" }

Response 404:
{ "error_code": "NOT_FOUND", "message": "Material not found" }
```

### 7.5 上傳流程的 Rollback 設計

`POST /materials` 涉及三個外部系統的寫入，任何一步失敗都需要 rollback：

```
步驟順序                              失敗時 rollback 動作
─────────────────────────────────────────────────────────
(1) 驗證檔案類型、大小                  (無，直接 4xx 回應)
(2) 計算 SHA-256、判重                  (無)
(3) 上傳 Supabase Storage              → 刪除 Storage 檔案
(4) 上傳到 Dify Knowledge Base         → 刪除 Storage 檔案
(5) Prisma create materials 紀錄       → 刪除 Storage 檔案、Dify 文件
```

實作上以 try/catch 包覆整個流程，並維護「已完成步驟清單」，失敗時逆序回滾。

### 7.6 權限管理設計

#### 角色模型

採用最小可行模型：

|角色       |Materials 權限|會議權限（Vexa）   |
|---------|------------|-------------|
|**Admin**|上傳、刪除任何資料   |管理所有會議、邀 Bot |
|**User** |上傳、刪除自己的資料  |建立自己的會議、邀 Bot|


> 後續若需擴充為「Knowledge Pack 共享」模型（多個 materials 組成資料集、可分享給其他 user），可在 Phase 4+ 加入。

#### 認證流程

```
1. 使用者透過 Vexa Dashboard 登入（NextAuth）
2. NextAuth 簽發 JWT，內含 user.id、user.role
3. Materials 頁面從 session 取出 JWT
4. 呼叫 App Backend 時帶 Authorization: Bearer <JWT>
5. App Backend 用相同的 NEXTAUTH_SECRET 驗證 JWT
6. Middleware 將 user info 注入 context，供 handler 使用
```

#### 認證 Middleware（範例）

```typescript
// middleware/auth.ts
import { jwtVerify } from "jose"

export async function authMiddleware(c: Context, next: Next) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "")
  if (!token) return c.json({ error: "Unauthorized" }, 401)

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(process.env.NEXTAUTH_SECRET)
    )
    c.set("user", payload)
    await next()
  } catch {
    return c.json({ error: "Invalid token" }, 401)
  }
}

// middleware/requireRole.ts
export function requireRole(role: "ADMIN" | "USER") {
  return async (c: Context, next: Next) => {
    const user = c.get("user")
    if (user.role !== role && role === "ADMIN") {
      return c.json({ error: "Forbidden" }, 403)
    }
    await next()
  }
}
```

#### 路由保護（範例）

```typescript
app.use("/materials/*", authMiddleware)

app.post("/materials", uploadHandler)
app.get("/materials", listHandler)            // 在 handler 內依角色過濾
app.delete("/materials/:id", deleteHandler)   // 在 handler 內檢查擁有者
```

#### 資料層權限策略

採「應用層過濾」（適合學期專題範圍）：

```typescript
// list handler
const materials = await prisma.material.findMany({
  where: user.role === "ADMIN"
    ? { deletedAt: null }
    : { deletedAt: null, uploadedByUserId: user.id }
})
```

未來若需更嚴謹的隔離，可改用 Postgres Row Level Security (RLS)。

### 7.7 環境變數設計

```bash
# === Backend (.env) ===

# Supabase
DATABASE_URL="postgresql://postgres:[PWD]@db.[PROJ].supabase.co:5432/postgres?schema=app"
SUPABASE_URL="https://[PROJ].supabase.co"
SUPABASE_SERVICE_ROLE_KEY="..."
SUPABASE_STORAGE_BUCKET="meeting-materials"

# Dify
DIFY_API_BASE="https://api.dify.ai/v1"
DIFY_API_KEY="dataset-..."
DIFY_DATASET_ID="..."

# Auth (與 Vexa Dashboard 共用)
NEXTAUTH_SECRET="..."

# App
APP_PORT=4000
APP_CORS_ORIGINS="http://localhost:3000"
MAX_FILE_SIZE_MB=15
```

```bash
# === Forked Vexa Dashboard (.env.local) ===

# 原 Vexa Dashboard 設定保留
VEXA_API_URL=http://vexa-lite:8056
VEXA_ADMIN_API_KEY=...
NEXTAUTH_SECRET=...                                 # 與 Backend 共用

# 新增：指向你的 Materials Backend
NEXT_PUBLIC_MATERIALS_API=http://localhost:4000
```

### 7.8 部署架構（docker-compose 概覽）

```yaml
services:
  vexa-lite:
    image: vexaai/vexa-lite:latest
    # ... 連到 Supabase Postgres

  app-dashboard:
    build: ./vexa-dashboard-fork    # ← Fork 後的版本
    ports: ["3000:3000"]
    environment:
      VEXA_API_URL: http://vexa-lite:8056
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      NEXT_PUBLIC_MATERIALS_API: http://localhost:4000

  app-backend:
    build: ./backend                # ← 自開發的 Hono 服務
    ports: ["4000:4000"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      DIFY_API_KEY: ${DIFY_API_KEY}
```

Supabase Postgres、Storage 和 Dify 為外部 SaaS，不在 compose 內。

### 7.9 Phase 1 時程

|天數            |任務                                              |
|--------------|------------------------------------------------|
|Day 1 上午      |Supabase + Vexa-lite 起來 + 確認 schema 分離          |
|Day 1 下午      |Dify 環境 + Node.js 專案初始化 + Prisma migrate        |
|Day 2         |POST /materials + Supabase Storage + Dify upload|
|Day 3 上午      |GET / DELETE endpoints + status polling job     |
|Day 3 下午      |Fork Vexa Dashboard + 新增 Materials 頁面           |
|Day 4         |串接 + 權限測試 + 整合測試                                |
|Day 5         |Demo 錄製、文件、bug fix                              |
|Day 6 (buffer)|風險應對                                            |

### 7.10 Phase 1 風險與備案

|風險                       |影響         |備案                                   |
|-------------------------|-----------|-------------------------------------|
|Dify 索引非同步，使用者不知何時好      |UX 不佳      |前端輪詢更新狀態；告知「需等索引完成才能使用」              |
|Storage 成功但 Dify 失敗      |資料不一致      |Rollback 邏輯：Dify 失敗就刪 Storage 檔      |
|大檔案上傳 timeout            |卡在上傳畫面     |Hono 設定 timeout；前端 streaming upload  |
|Dify cloud 免費額度用完        |上傳失敗       |開發前先確認額度；必要時改 self-host              |
|中文 PDF chunking 效果差      |RAG 答案不準   |Phase 1 末段做品質測試，調整 chunk size        |
|Vexa 升級時 public schema 變動|Prisma 定義過時|CI 加 `prisma db pull --print` 比對 diff|
|跨服務 NextAuth JWT 驗證失敗    |認證壞掉       |退路：改用 Backend 自簽 API Key             |
|上傳敏感資料的安全疑慮              |資料外洩       |Storage 設 private；API 強制認證；計劃書註明資料隔離 |

### 7.11 Phase 1 完成 Checklist

```
基礎設施
  □ Supabase 專案運作，schema 分離設定完成
  □ Vexa-lite 容器運行正常
  □ Dify Knowledge Base 建好

Backend
  □ POST /materials 上傳一份 PDF 成功
  □ GET /materials 列表回傳正確（依角色過濾）
  □ DELETE /materials/:id 三方資料都清除
  □ 重複檔案上傳會回 409
  □ 過大檔案會回 413
  □ Rollback 邏輯能運作（手動破壞測試）
  □ User 無法刪 Admin 上傳的（回 403）

Frontend
  □ Fork 後 Vexa Dashboard 原功能正常
  □ /materials 頁面可拖拉上傳
  □ 管理頁顯示清單、狀態 badge、可刪除
  □ 處理中項目會自動輪詢更新狀態
  □ 角色不同看到的內容不同

整合驗證
  □ 上傳的檔案在 Dify chat 能正確被檢索回答問題
  □ NextAuth JWT 在前後端流通正常
  □ Demo 影片錄製完成
```

-----

## 8. 後續 Phase 概覽

Phase 0 與 Phase 1 完成後，後續開發藍圖如下：

### Phase 2：Bot 與轉錄串接（1-2 週，待細節規劃）

- 後端可指令 Bot 加入 / 離開 Google Meet
- 接收 Vexa transcription，儲存到 `app.transcripts` 表
- 在 Dashboard 即時顯示逐字稿
- ✅ Demo：Bot 進會議，Dashboard 看到逐字稿

### Phase 3：喚醒詞 + RAG 整合（1-2 週，待細節規劃）

- 在 chat 與轉錄流上偵測「小幫手」
- 擷取問題、呼叫 Dify workflow
- 依來源用 chat 或 speak 回覆
- Q&A 紀錄存到 `app.qa_logs`
- ✅ Demo：完整流程跑通

### Phase 4：優化與計劃書（1 週）

- UX 優化、錯誤處理
- 計劃書最終版、demo 影片
- 延伸方向探討（Chrome Extension、Knowledge Pack 共享等）

-----

## 9. 整體風險與緩解策略

|類別   |風險                 |緩解策略                      |
|-----|-------------------|--------------------------|
|技術可行性|Vexa 中文喚醒詞辨識不準     |Phase 0 PoC B 先驗證，備案改英文喚醒詞|
|技術可行性|語音回覆延遲過高           |Phase 0 量測延遲；備案加「我來查一下」過渡語|
|架構穩定性|Vexa schema 變動     |Schema 分離 + CI diff 檢查    |
|架構穩定性|Vexa Dashboard 升級衝突|採層次 1 整合（最淺改動）            |
|資料安全 |上傳敏感內部文件           |Private Storage、強制認證、權限隔離 |
|進度風險 |Phase 0 PoC 失敗     |預留 buffer 時間；備案方案文件化      |
|進度風險 |學期時間有限             |階段切分 + 每階段都有可 demo 成果     |

-----

## 10. 參考資料

### 10.1 官方文件

- Vexa Documentation: <https://docs.vexa.ai/>
- Vexa Interactive Bots: <https://docs.vexa.ai/interactive-bots>
- Vexa Lite Deployment: <https://docs.vexa.ai/vexa-lite-deployment>
- Dify Documentation: <https://docs.dify.ai/>
- Supabase Documentation: <https://supabase.com/docs>
- Prisma multiSchema: <https://www.prisma.io/docs/orm/prisma-schema/data-model/multi-schema>

### 10.2 相關開源專案

- Vexa 主專案: <https://github.com/Vexa-ai/vexa>
- Vexa Dashboard (services/dashboard): <https://github.com/Vexa-ai/vexa/tree/main/services/dashboard>
- Vexa Chrome Extension: <https://github.com/Vexa-ai/vexa-chrome-extension>

### 10.3 技術棧文件

- Hono: <https://hono.dev/>
- Prisma: <https://www.prisma.io/docs>
- NextAuth.js: <https://next-auth.js.org/>
- Zod: <https://zod.dev/>

-----

**文件結尾**

如有任何問題或建議，歡迎於進入下一階段細節規劃前提出。