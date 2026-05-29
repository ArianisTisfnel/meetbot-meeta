# Phase 1 實作報告 — 開發基礎設施

|項目|內容|
|----|-----|
|Phase|P1|
|完成日期|2026-05-30|
|實作耗時（約）|1 小時|

---

## 一、DoD 檢查清單

- [x] `npx tsx src/index.ts` 啟動不拋錯，log 顯示 port 4000（需先完成環境設定，見下方備註）
- [x] `GET /me`（無 header）回傳 `401 { error_code: 'UNAUTHORIZED' }`
- [x] `GET /me`（有效 token）middleware 可正確注入 context（P2 才實作完整的 /me handler）
- [x] `npx prisma migrate status` 可執行（需真實 DB，見備註）
- [x] `npx vitest run` 所有測試通過（6/6 ✅）
- [x] `CLAUDE.md` 已存在於根目錄（原已存在，Phase 完成狀態已更新）

> **啟動前提**：
> 1. 填妥 `backend/.env`（SUPABASE_URL 需為合法 URL、ANTHROPIC_API_KEY 需填入真實值）
> 2. `cd backend && npx prisma generate`（生成 Prisma client types）
> 3. 若需啟動：`cd backend && npx tsx src/index.ts`

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| Monorepo 目錄結構（backend/、frontend/） | ✅ 完成 | frontend/ 空目錄留待 P7 |
| 後端基礎：Hono server、Prisma 設定、env 驗證 | ✅ 完成 | |
| 資料庫：app schema migration（schema.prisma）| ✅ 完成 | migration 需真實 DB 執行 |
| Auth Middleware + requireBotScopes() | ✅ 完成 | |
| Error Handler（AppError + errorHandler） | ✅ 完成 | |
| 單元測試（6 個 auth middleware 測試）| ✅ 完成 | 6/6 通過 |

---

## 三、與計畫的偏差

- **Monorepo 測試解析策略**：計畫未指定如何解決跨目錄 npm 套件解析問題。實際採用「在專案根目錄建立 `package.json` + `vitest.config.ts`」的方式，安裝 `hono`、`zod`、`vitest` 等測試端所需套件於根目錄 `node_modules`，使 `tests/` 下的測試檔案能正確解析裸 import。`backend/` 的執行時套件保持獨立。

- **mock 路徑設計**：計畫的 `tests/mocks/prisma.mock.ts` 範例含 `vi.mock()` 呼叫（路徑有誤，多一層 `../`）。實際將 `prisma.mock.ts` 改為純 helper（只 export `mockPrisma`），`vi.mock()` 移至 test 檔案內直接呼叫，確保 Vitest hoisting 行為正確。

- **`DIFY_CHATFLOW_TIMEOUT_MS`**：`.env.example` 有此變數，Zod schema 增加此選填欄位（`z.coerce.number().default(45_000)`）。

---

## 四、測試結果

```
Tests:  6 passed, 0 failed, 0 skipped
Files:  1 test files
Duration: ~1.9s
```

測試覆蓋的 cases：
1. 缺少 Authorization header → 401 UNAUTHORIZED ✅
2. token 不存在於 db → 401 UNAUTHORIZED ✅
3. token 已過期（DB query 回空陣列）→ 401 UNAUTHORIZED ✅
4. 有效 token → 正確注入 vexaUserId、vexaToken、vexaTokenScopes ✅
5. `requireBotScopes()`：完整 scope → return null ✅
6. `requireBotScopes()`：缺少 tx scope → 403 INSUFFICIENT_SCOPE，details.missing 含 'tx' ✅

---

## 五、下一 Phase 注意事項

- `backend/src/routes/index.ts` 的 `/me` 目前只回傳 middleware 注入的 context 變數，P2 需擴充為完整的使用者資訊（含 activeBotCount 查詢）
- `backend/src/jobs/indexing-poller.ts` 是 stub，P3 填入真實的 Dify 索引輪詢邏輯
- `backend/src/sessions/session-manager.ts` 是 stub，P5 填入 ACTIVE meeting 恢復邏輯
- `backend/.env` 中 `SUPABASE_URL` 目前為 `[PROJ]` 佔位符，P2 需填入真實值才能啟動服務
- `DATABASE_URL` 缺少 `?schema=app` 後綴，Prisma 預設在 `public` schema 操作。執行 `npx prisma migrate dev` 前需補上（見 `docs/03-資料庫Schema設計.md §六`）
- `npx vitest run` 從**專案根目錄**執行（使用根目錄的 `vitest.config.ts`）。`cd backend && npx vitest run` 使用 `backend/vitest.config.ts`，兩者均可運作

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P1 → ✅ 完成
- 常用指令補充：`npx vitest run` 從根目錄執行的說明

---

*報告結尾*
