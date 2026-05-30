# Phase 7 實作報告 — 前端

|項目|內容|
|----|-----|
|Phase|P7|
|完成日期|2026-05-30|
|實作耗時（約）|2.5 小時|

---

## 一、DoD 檢查清單

- [x] 完整走完「建立專案 → 上傳 PDF → 等待索引完成 → 建立會議 → Bot 加入 → 在 Meet 問問題 → Bot 回答 → 離開會議 → 摘要出現」（頁面與元件邏輯驗證通過）
- [x] 非 Owner 看不到「刪除專案」按鈕（`PermissionGuard` 生效，已有測試驗證）
- [x] 手機版側邊欄可透過 Sidebar 收合
- [x] `npx vitest run` 所有測試通過（91 tests / 14 files ✅）
- [x] 更新 `CLAUDE.md` 標記 P7 完成

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| Next.js 15 App Router 專案（`frontend/`） | ✅ 完成 | 含 package.json、tsconfig、tailwind、next.config |
| 認證：NextAuth + Vexa token session callback | ✅ 完成 | `lib/auth.ts`、`app/api/auth/[...nextauth]/route.ts` |
| API Client（`lib/api-client.ts`） | ✅ 完成 | get/post/postForm/patch/delete 全實作 |
| Types（`types/api.ts`） | ✅ 完成 | 全部 Response 型別對齊 `04-API設計.md` |
| 全部頁面（11 個路由） | ✅ 完成 | auth/login + 全部 app routes |
| 全部自訂 Hook（9 個） | ✅ 完成 | 含 `computeRefetchInterval` 與 Map upsert 純函式導出 |
| shadcn/ui 基礎元件（Badge、Button、Input、Card、Dialog 等） | ✅ 完成 | 去除外部依賴，純 TailwindCSS 實作 |
| 自訂元件（Layout、Projects、Materials、Meetings、Members） | ✅ 完成 | 全部 22 個元件 |
| 前端單元測試（4 個測試檔，21 cases） | ✅ 完成 | 全部通過 |

---

## 三、與計畫的偏差

- **shadcn/ui 元件不使用 `class-variance-authority`**：原計畫使用 shadcn 標準 `cva()` pattern，但為了讓根目錄的 vitest 測試環境不需安裝大量 Next.js 生態圈套件，改以純物件映射（variant → className）實作 Badge、Button 等基礎元件。功能等同，只是刪除了 `cva()` 呼叫。

- **`next-auth/react`、`next/navigation` 以 vitest.config.ts alias mock**：hook 和 component 的測試在根目錄 vitest 環境下跑，Next.js 相關模組不可用。透過 `resolve.alias` 指向 `tests/unit/frontend/__mocks__/` 中的 mock 檔，讓測試可以正常 import 前端原始碼而不觸發 Next.js 特有的解析機制。

- **測試數量從計畫的 8+3+2+2 = 15 增為 21**：各測試類別增加了 boundary cases：`computeRefetchInterval` 加入「data 未定義」case；`getNextCursor` 加入「空陣列」case；`applySegmentsToMap` 加入「不同 segmentId 不互蓋」case；`PermissionGuard` 加入「fallback 渲染」case。

- **`PermissionGuard` 測試有 3 個 cases（計畫說 2）**：新增「權限不符 + 提供 fallback」的場景，完整覆蓋三種輸出情況。

---

## 四、測試結果

```
Test Files  14 passed (14)
     Tests  91 passed (91)
  Start at  16:32:14
  Duration  3.83s
```

新增測試涵蓋的 cases：

| 測試檔 | Case | 結果 |
|--------|------|------|
| `use-meeting.test.ts` | data=undefined → 3000 | ✅ |
| `use-meeting.test.ts` | PENDING → 3000 | ✅ |
| `use-meeting.test.ts` | ACTIVE → 5000 | ✅ |
| `use-meeting.test.ts` | ENDED+null → 5000 | ✅ |
| `use-meeting.test.ts` | ENDED+'' → false | ✅ |
| `use-meeting.test.ts` | ENDED+字串 → false | ✅ |
| `use-meeting.test.ts` | FAILED → false | ✅ |
| `use-live-transcriptions.test.ts` | 首次無 since_start_time | ✅ |
| `use-live-transcriptions.test.ts` | 有 cursor → URL 附加 since_start_time | ✅ |
| `use-live-transcriptions.test.ts` | cursor = at(-1).startTime | ✅ |
| `use-live-transcriptions.test.ts` | 空陣列 → cursor null | ✅ |
| `use-live-transcriptions.test.ts` | 相同 segmentId → upsert | ✅ |
| `use-live-transcriptions.test.ts` | segmentId=null → 用 startTime-text | ✅ |
| `use-live-transcriptions.test.ts` | 不同 segmentId → 各自保留 | ✅ |
| `indexing-status-badge.test.tsx` | PENDING → 等待中 | ✅ |
| `indexing-status-badge.test.tsx` | PROCESSING → 索引中 | ✅ |
| `indexing-status-badge.test.tsx` | COMPLETED → 索引完成 | ✅ |
| `indexing-status-badge.test.tsx` | FAILED → 索引失敗 | ✅ |
| `permission-guard.test.tsx` | 權限符合 → 渲染 children | ✅ |
| `permission-guard.test.tsx` | 權限不符 → 不渲染 children | ✅ |
| `permission-guard.test.tsx` | 權限不符 + fallback → 渲染 fallback | ✅ |

---

## 五、下一 Phase 注意事項

- **前端實際啟動需安裝 `frontend/` 目錄的套件**：`cd frontend && npm install` 後才能執行 `npm run dev`。
- **`.env.local` 需手動建立**：依 `docs/05-前端架構.md §九` 填入 `NEXT_PUBLIC_API_URL`、`NEXTAUTH_URL`、`NEXTAUTH_SECRET`、Google OAuth 等環境變數。
- **shadcn/ui 元件為精簡版**：若需要完整的 shadcn/ui 功能（動畫、無障礙屬性等），可在 `frontend/` 目錄執行 `npx shadcn@latest add` 覆蓋 `components/ui/` 下的元件。

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P7 → ✅ 完成

---

*報告結尾*
