# CLAUDE.md — meetbot 專案脈絡

## 專案簡介

meetbot 是一個 AI 會議助理，讓「蜜塔（Meeta）」機器人加入 Google Meet，  
監聽喚醒詞後回答問題，會議結束後自動生成摘要。

---

## 技術棧

| 層次 | 技術 |
|------|------|
| Backend | Hono（Node.js 20+）+ Prisma + Vitest |
| Frontend | Next.js 15 App Router + shadcn/ui + TanStack Query v5 |
| 資料庫 | PostgreSQL（本機 Docker / Supabase），單一 `app` schema |
| 外部服務 | Recall.ai（Bot/逐字稿）、Dify（RAG/摘要）、Supabase Storage 或 MinIO、Anthropic Claude、Gemini |

---

## Schema 架構

**2026-08 起單一 `app` schema。** 身份層（使用者、API token）原本寄生在 Vexa 的
`public.users` / `public.api_tokens`，移除 Vexa 後整套搬進 `app.users` / `app.user_tokens`，
程式碼**不再有任何 `public.*` 的 `$queryRaw`**。

- 使用者關聯欄位名仍是 `*_vexa_user_id`（`@map` 保留 DB 欄位名，只是沒改名），
  Prisma model 上一律是 `ownerUserId` / `userId` / `createdByUserId`
- 這些欄位**不建 FK 約束**（沿用原本的邏輯 FK 策略）；唯一有 FK 的是 `user_tokens.user_id`
- 舊的 `public` 表留在 DB 但沒有程式碼碰它；`schemas = ["app"]` 下 db push 也不會動到

---

## 關鍵設計決策（避免重踩的坑）

1. **provider 抽象層**：上層（session/喚醒詞/插話/摘要）只認 `MeetingBotProvider` 介面，**不得出現 provider 名稱的條件分支**。目前唯一實作是 `RecallAdapter`；逐字稿與聊天室訊息走 Recall webhook 推送（不再有 per-session WebSocket，那是 Vexa 時代的產物）
2. **in-memory activeSessions Map**：Bot session 狀態全在記憶體，**不可多進程部署**（PM2 fork mode 是唯一安全方案）
3. **DB 轉 ACTIVE 時機**：建立 meeting 後 DB 維持 PENDING，待 bot **真的被准入**才轉 ACTIVE。ACTIVE 的語意是「蜜塔在會議裡」，並發上限與前端狀態都靠它，提前設會讓人以為成功又白佔額度
4. **handleSessionClose 原子鎖**：先從 Map delete，再做後續處理，確保摘要只觸發一次
5. **summary sentinel**：`summary = null` = 摘要尚未生成（前端繼續輪詢）；`summary = ''` = 已嘗試但無內容（前端停止輪詢）；有字串 = 正常
6. **逐字稿只活在記憶體**：segment 沒落 DB，會議結束或後端重啟後就取不回來（`GET .../transcriptions` 回空陣列並留 warn log，重啟時 ACTIVE 會議一律收尾成 ENDED）。會後的 Markdown 逐字稿有存 Storage，不受影響。詳見 `docs/13-系統現況與路線圖.md § 已知限制`

---

## 目錄結構

```
meetbot/
├── backend/          ← Hono 後端
├── frontend/         ← Next.js 前端
├── tests/
│   ├── unit/         ← Vitest 單元測試（mock 外部依賴）
│   ├── integration/  ← 整合測試（需真實服務，手動執行）
│   └── mocks/        ← 外部服務 mock（prisma/dify/supabase）
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
| P1 | 開發基礎設施 | ✅ 完成 | [Phase1-報告](docs/10-實作報告/Phase1-報告.md) |
| P2 | 專案與成員管理 | ✅ 完成 | [Phase2-報告](docs/10-實作報告/Phase2-報告.md) |
| P3 | 資料管理 | ✅ 完成 | [Phase3-報告](docs/10-實作報告/Phase3-報告.md) |
| P4 | 會議基礎 | ✅ 完成 | [Phase4-報告](docs/10-實作報告/Phase4-報告.md) |
| P5 | Bot Session 與問答 | ✅ 完成 | [Phase5-報告](docs/10-實作報告/Phase5-報告.md) |
| P6 | 會議摘要 | ✅ 完成 | [Phase6-報告](docs/10-實作報告/Phase6-報告.md) |
| P7 | 前端 | ✅ 完成 | [Phase7-報告](docs/10-實作報告/Phase7-報告.md) |

> 每個 Phase 完成後，將 ⬜ 改為 ✅，並填入報告連結。

---

## 常用指令

```bash
# 後端啟動（必須用 npm run dev：script 帶 --env-file .env，裸跑 npx tsx 不會載入環境變數）
cd backend && npm run dev

# 執行單元測試（從專案根目錄）
npx vitest run

# DB schema 同步（本專案是 db push 工作流，無 migrations 目錄；需 .env 有 DIRECT_URL）
# ⚠️ 前後各有一段一次性遷移 SQL（移除 Vexa），start.ps1 會自動跑；手動做見 docs/03 §七
npx prisma db push
```

---

## Session 結束時的固定任務

每次 Session 結束前，**必須**將本次變更提交至 git：

- 依變更範圍拆成一次或多次 commit（不強制合併成一個）
- commit 標題用**英文**
- commit 內容說明用**中文 + 英文**

---

## 關鍵文件索引

> ⚠️ **文件分兩類，務必分辨**：
> - 🟢 **活文件**：須與目前程式碼同步，可當現行規格參考。若與程式不符，**以程式為準**並回寫文件。
> - 🔒 **凍結快照**：記錄當時的決策/計畫/報告，**不一定反映現況**，**不可當作現行規格**。
>
> 每份文件開頭都有對應的 🟢／🔒 banner。

### 🟢 活文件（須與程式同步）

| 需要了解... | 讀這個文件 |
|------------|-----------|
| 使用者需求與功能範圍 | `docs/02-使用者需求.md` |
| DB Schema 與 rollback 策略 | `docs/03-資料庫Schema設計.md` |
| API 端點與錯誤碼 | `docs/04-API設計.md` |
| 前端路由與 Hook 設計 | `docs/05-前端架構.md` |
| 後端架構（Session/WS/摘要） | `docs/06-後端架構.md` |
| 系統現況/路線圖/可測清單/使用的開源 | `docs/13-系統現況與路線圖.md` |
| 環境變數（.env）全部清單、速查與除錯 | `docs/14-環境變數設定說明.md` |
| Recall／ngrok 專屬設定 | `docs/13-Recall-Failover-開發設定.md` |
| 拉新 code 後的部署步驟（依序照做） | `docs/14-部署步驟.md` |
| **拉新 code 後環境要不要動** | `docs/` 底下編號最大的 `NN-…環境設定.md`（見下） |

#### 慣例：大改動合併時附一份「環境設定」文件

每次較大的分支合併，附一份 `docs/NN-<主題>環境設定.md`（已有 `17`、`19`），內容只講
**組員要動手做什麼**：要不要 `npm install`／`db push`、要不要加環境變數、要不要裝東西，
**「不用做」的項目也要列出來**——讓人確認過，而不是自己猜。

- 掛分支／主題名，記錄的是**那次合併**的狀態，讀完即退場，**不必回頭維護**
- 因此**不列進上面的索引表**（列了就得年年更新），拉完 code 看 `docs/` 有沒有新編號即可
- 沒有新檔 = 環境沒有變更
- 背景與設計說明另外寫，別塞進這份（例：`16` 講原因、`17` 講動手）

### 🔒 凍結快照（歷史紀錄，勿當現況）

| 內容 | 文件 |
|------|------|
| 細節補丁整合追蹤（已併入 02–06） | `docs/07-細節.md` |
| 設計評估記錄 | `docs/08-評估提示詞.md` |
| 各 Phase 實作計畫 | `docs/09-實作計畫/*` |
| 各 Phase 完成報告 | `docs/10-實作報告/*` |
| 優化／待辦清單 | `docs/11-優化清單.md` |
| 文件一致性修正報告 | `docs/12-文件一致性修正報告.md` |

> 開發環境設定（人工操作）：`docs/09-實作計畫/00-環境設定.md`（凍結，但環境步驟仍適用）。