# MeetBot — 會議 AI 小幫手

> 將 AI 助理「蜜塔（Meeta）」帶進 Google Meet：  
> 喚醒即回答、根據專案資料即時查詢、會議結束後自動生成摘要與交辦事項。

---

## 專案概述

MeetBot 是一套以**專案為核心**的會議 AI 管理系統。每個專案擁有獨立的知識庫，成員可上傳會議背景資料；開會時邀請 Bot「蜜塔（Meeta）」加入 Google Meet，透過語音或聊天室說出喚醒詞，即可即時獲得來自專案資料的回答。

```
專案資料（PDF / DOCX / TXT / MD）
        ↓ 上傳至 Dify Knowledge Base
Google Meet 會議
        ↓ 蜜塔加入，監聽逐字稿
喚醒詞「蜜塔」或「小幫手」
        ↓ 查詢 Dify Chatflow
語音或聊天室回答
        ↓ 會議結束
自動生成摘要 + 交辦事項
```

---

## 技術棧

| 層次 | 技術 |
|------|------|
| 前端 | Next.js 15（App Router）+ shadcn/ui + TanStack Query v5 |
| 後端 | Hono（Node.js）|
| ORM | Prisma（multiSchema：`app` + `public`）|
| 資料庫 / Storage | Supabase（PostgreSQL + Storage）|
| Bot 基礎設施 | [Vexa-lite](./vexa/)（`vexa/` 子目錄）|
| AI / RAG | Dify（Knowledge Base + Chatflow 工作流）|
| 語音合成 | OpenAI TTS（透過 Vexa `/speak` 代為呼叫，後端不直接整合）|
| 認證 | NextAuth（Google OAuth，由 Vexa Dashboard 管理）|

---

## 文件索引（`docs/`）

### 🗂 歷史檔案（僅供參考，已被後續版本取代）

| 檔案 | 說明 |
|------|------|
| [00-會議助手Bot專案計劃書-Phase0-Phase1.md](docs/00-會議助手Bot專案計劃書-Phase0-Phase1.md) | 最初的 MVP 計劃書（Phase 0–1），當前架構已大幅調整，僅保留作歷史紀錄 |
| [00-工作分配-成員A-後端與資料.md](docs/00-工作分配-成員A-後端與資料.md) | 早期的人工分工草稿，現已由 Claude 統一負責設計與開發 |

---

### 📌 基準文件（權威來源）

| 檔案 | 說明 |
|------|------|
| [01-專案目標.md](docs/01-專案目標.md) | **專案唯一權威文件**。所有其他文件若與此文件衝突，以此為準。記錄核心目標、技術選型決策、使用者流程原稿 |

---

### 📚 背景參考（外部系統規格）

| 檔案 | 說明 |
|------|------|
| [01-vexa-lite-schema.md](docs/01-vexa-lite-schema.md) | Vexa-lite 的 `public` schema 定義（`users`、`meetings`、`transcriptions`、`api_tokens` 等關鍵表）。後端唯讀存取此 schema，不建跨 schema FK |
| [01-RAG_API_串接文件_v1.1.md](docs/01-RAG_API_串接文件_v1.1.md) | Dify API 完整規格（v1.1）。包含：Knowledge Base 上傳（回傳 `batch` 用於輪詢）、索引狀態查詢、RAG Q&A Chatflow（多輪對話 `conversation_id`）、會議摘要 Workflow（file 傳入模式）、四把獨立 API Key 的用途說明 |

---

### 🛠 開發文件（實作依據，按順序閱讀）

| 檔案 | 版本 | 說明 |
|------|------|------|
| [02-使用者需求.md](docs/02-使用者需求.md) | v1.4 | 完整使用者需求規格。涵蓋認證、專案與成員管理（含參與者可獲授 canMeeting 權）、檔案上傳流程、會議實例、Bot 互動（含歡迎訊息、雙喚醒詞）、會議結束後 MD 存檔 + Dify 摘要流程 |
| [03-資料庫Schema設計.md](docs/03-資料庫Schema設計.md) | v1.7 | Prisma multiSchema 完整定義（`app` schema）、雙 schema 隔離策略、Table 關聯圖、SHA-256 判重、三方 Rollback 流程、Bot Session 記憶體結構；ProjectMember 含 canMeeting 欄位 |
| [04-API設計.md](docs/04-API設計.md) | v1.6 | REST API 完整規格（Request / Response / 錯誤碼）、vexaToken 認證策略、背景工作說明（含 MD 存檔 + Dify Files 上傳）、前端輪詢策略、5 欄位權限矩陣 |
| [05-前端架構.md](docs/05-前端架構.md) | v1.5 | Next.js App Router 資料夾結構、路由與頁面責任、ASCII wireframe（含 canMeeting 欄位）、TanStack Query 自訂 Hook、API Client 實作、PermissionGuard 元件 |
| [06-後端架構.md](docs/06-後端架構.md) | v2.3 | Hono 資料夾結構、認證 middleware、Bot Session 管理（WebSocket + 喚醒詞偵測）、Dify 服務封裝（含 uploadTranscriptFile + generateSummary file 模式）、背景工作、服務重啟恢復策略 |

---

## 關鍵設計決策

### 認證
前端使用 `session.vexaToken`（Vexa 原本即有），後端透過查詢 `public.api_tokens` 驗證身份（含 `expires_at` 過期檢查），無需另行管理 JWT Secret。

### Vexa WebSocket 整合
後端為每個進行中的會議建立**獨立的 `/ws` 連線**（以邀請者的 `vexaToken` 認證）：
- 每個 MeetingSession 使用**邀請者自己的 token** 建立專屬 WebSocket，訂閱該會議的三條 Redis channel
- Vexa WS 授權以 `Meeting.user_id == current_user.id` 驗證，必須用邀請者 token（單一服務級 token 無法訂閱其他使用者的會議事件）
- 每個 `POST /bots` 需帶 `voice_agent_enabled: true` 才能啟用 `/speak`（TTS）與 `/chat` 功能
- TTS 回覆透過 `POST /bots/{platform}/{nativeMeetingId}/speak` 傳送文字，由 Vexa 內部呼叫 OpenAI TTS 並播放

### Bot 名稱與喚醒詞
Bot 官方名稱為「**蜜塔（Meeta）**」，口語稱呼「**小幫手**」。兩個喚醒詞均有效：
```
正規表達式：/[蜜密祕秘迷][塔搭]|小幫手/
```

### Schema 隔離
- `public` schema：Vexa-lite 自動管理，我方**唯讀**
- `app` schema：我方以 Prisma migrate 管理，不建跨 schema FK

### 雙 Meeting ID 設計
`meeting_instances` 同時儲存兩個 Vexa 相關 ID：

| 欄位 | 型別 | 用途 |
|------|------|------|
| `vexa_meeting_id` | `Int` | 查詢 `public.transcriptions`（整數 FK） |
| `vexa_native_meeting_id` | `String` | 呼叫 Bot API（`DELETE /bots/{platform}/{id}`）|

### Token 恢復策略
`meeting_instances` 儲存 `creator_api_token_id`（指向 `public.api_tokens.id` 的整數參考），服務重啟後透過此 ID 查回 token 字串，恢復 MeetingSession，不在 DB 直接儲存 token 明文。

### Dify API Key 分工
| 變數 | 用途 |
|------|------|
| `DIFY_DATASET_API_KEY` (`dataset-...`) | Knowledge Base：上傳/刪除文件、索引狀態輪詢 |
| `DIFY_WORKFLOW_API_KEY` (`app-...`) | RAG Q&A Chatflow（`01-edu2.yml`，多輪對話） |
| `DIFY_SUMMARY_WORKFLOW_API_KEY` (`app-...`) | 檔案摘要 Workflow（上傳後的即時內容預覽） |
| `DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY` (`app-...`) | 會議摘要 Workflow（會議結束後自動觸發） |

---

## 目錄結構（預計）

```
meetbot/
├── README.md
├── docs/                  # 所有規劃文件（見上表）
├── frontend/              # Next.js 15 App（待建立）
├── backend/               # Hono Node.js API（待建立）
└── vexa/                  # Vexa-lite 子模組（Bot 基礎設施）
```

---

## Vexa-lite

`vexa/` 目錄為 [Vexa-lite](https://github.com/Vexa-ai/vexa) 開源專案，作為 Google Meet Bot 的基礎設施。啟動方式：

```bash
cd vexa/deploy/compose
docker compose up -d
```

詳見 [vexa/CLAUDE.md](vexa/CLAUDE.md)（Vexa 開發工作流說明）與 [vexa/deploy/compose/README.md](vexa/deploy/compose/README.md)。
