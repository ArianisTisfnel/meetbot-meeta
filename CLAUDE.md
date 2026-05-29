# CLAUDE.md — meetbot 專案脈絡

## 專案簡介

meetbot 是一個 AI 會議助理，讓「蜜塔（Meeta）」機器人加入 Google Meet，  
監聽喚醒詞後回答問題，會議結束後自動生成摘要。

---

## Tech Stack

| 層次 | 技術 |
|------|------|
| Backend | Hono（Node.js 20+）+ Prisma multiSchema + Vitest |
| Frontend | Next.js 15 App Router + shadcn/ui + TanStack Query v5 |
| 資料庫 | Supabase PostgreSQL（雙 schema） |
| 外部服務 | Vexa-lite（Bot/逐字稿）、Dify（RAG/摘要）、Supabase Storage、Anthropic Claude |

---

## 雙 Schema 架構（最重要）

```
public schema  ← Vexa 管理，只讀。使用 prisma.$queryRaw 存取，禁止建立 FK 約束
app schema     ← 我們管理，Prisma migrate 控制
```

- 跨 schema 關聯以**整數邏輯 FK**（`vexa_user_id`、`vexa_meeting_id`）記錄，無 DB constraint
- `prisma.$queryRaw` 用於所有 `public.*` 查詢

---

## 關鍵設計決策（避免重踩的坑）

1. **per-session WebSocket**：每個活躍會議用邀請者自己的 token 建立獨立 WS 連線。原因：Vexa WS 授權以 `meeting.user_id == current_user.id` 判斷，單一服務 token 只能訂閱自己建立的會議
2. **in-memory activeSessions Map**：Bot session 狀態全在記憶體，**不可多進程部署**（PM2 fork mode 是唯一安全方案）
3. **DB 轉 ACTIVE 時機**：建立 meeting 後 DB 維持 PENDING，待 Vexa WS 送來 `{type:"meeting.status", payload:{status:"active"}}` 才轉 ACTIVE
4. **handleSessionClose 原子鎖**：先從 Map delete，再做後續處理，確保摘要只觸發一次
5. **summary sentinel**：`summary = null` = 摘要尚未生成（前端繼續輪詢）；`summary = ''` = 已嘗試但無內容（前端停止輪詢）；有字串 = 正常
6. **逐字稿欄位 alias**：Vexa REST API 回傳 `start`/`end`（Pydantic alias），非 `start_time`/`end_time`，需手動映射到 camelCase `startTime`/`endTime`

---

## 目錄結構

```
meetbot/
├── backend/          ← Hono 後端
├── frontend/         ← Next.js 前端
├── tests/
│   ├── unit/         ← Vitest 單元測試（mock 外部依賴）
│   ├── integration/  ← 整合測試（需真實服務，手動執行）
│   └── mocks/        ← 外部服務 mock（prisma/dify/supabase/vexa）
├── docs/
│   ├── 02~07-*.md    ← 設計文件（需求/Schema/API/前端/後端架構/細節）
│   ├── 08-評估提示詞.md ← 實作前的設計評估記錄
│   ├── 09-實作計畫/  ← Phase 實作計畫（此目錄）
│   └── 10-實作報告/  ← 各 Phase 完成後生成的報告
└── CLAUDE.md         ← 此文件
```

---

## Phase 完成狀態

| Phase | 名稱 | 狀態 | 報告 |
|-------|------|------|------|
| P1 | 開發基礎設施 | ⬜ 未開始 | — |
| P2 | 專案與成員管理 | ⬜ 未開始 | — |
| P3 | 資料管理 | ⬜ 未開始 | — |
| P4 | 會議基礎 | ⬜ 未開始 | — |
| P5 | Bot Session 與問答 | ⬜ 未開始 | — |
| P6 | 會議摘要 | ⬜ 未開始 | — |
| P7 | 前端 | ⬜ 未開始 | — |

> 每個 Phase 完成後，將 ⬜ 改為 ✅，並填入報告連結。

---

## 常用指令

```bash
# 後端啟動
cd backend && npx tsx src/index.ts

# 執行單元測試
npx vitest run

# Prisma migration
npx prisma migrate dev

# DB pull（同步 Vexa public schema）
npx prisma db pull   # ⚠️ 執行後務必 diff，只保留 User/Meeting/Transcription
```

---

## Session 結束時的固定任務

每次 Session 結束前，**必須**執行以下指令：

> 將本次變更內容依照你認為適合的方式進行一次或多次提交，提交訊息標題用英文，內容用中文加英文。

---

## 關鍵文件索引

| 需要了解... | 讀這個文件 |
|------------|-----------|
| 使用者需求與功能範圍 | `docs/02-使用者需求.md` |
| DB Schema 與 rollback 策略 | `docs/03-資料庫Schema設計.md` |
| API 端點與錯誤碼 | `docs/04-API設計.md` |
| 前端路由與 Hook 設計 | `docs/05-前端架構.md` |
| 後端架構（Session/WS/摘要） | `docs/06-後端架構.md` |
| 設計評估記錄 | `docs/08-評估提示詞.md` |
| 當前 Phase 計畫 | `docs/09-實作計畫/0N-*.md` |
| 前一 Phase 報告 | `docs/10-實作報告/Phase[N-1]-報告.md` |