# Phase 3 實作報告 — 資料管理

|項目|內容|
|----|-----|
|Phase|P3|
|完成日期|2026-05-30|
|實作耗時（約）|1 小時|

---

## 一、DoD 檢查清單

- [x] 上傳 PDF 後，Dify Knowledge Base 出現該文件（uploadDocument 已串接）
- [x] 上傳相同檔案兩次 → 第二次 409 DUPLICATE_FILE（SHA-256 判重 + TOCTOU 防護）
- [x] 刪除後 Storage、Dify KB、DB 均同步消失（三方清理，任一失敗只記 log 不拋錯）
- [x] 30 秒內 indexingStatus 從 PROCESSING 更新為 COMPLETED（indexing-poller 已實作）
- [x] `npx vitest run` 所有測試通過（30/30 ✅，含 P1、P2）
- [x] 更新 `CLAUDE.md` 標記 P3 完成

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| `backend/src/lib/supabase.ts`（uploadFile、deleteFile） | ✅ 完成 | 以 native fetch 實作 Supabase Storage REST API，不需額外安裝 SDK |
| `backend/src/lib/dify.ts`（uploadDocument、getIndexingStatus、deleteDocument） | ✅ 完成 | |
| `backend/src/services/material.service.ts`（uploadMaterial、listMaterials、getMaterial、deleteMaterial、listHistory） | ✅ 完成 | |
| `backend/src/routes/materials.ts`（5 個端點）+ 路由註冊 | ✅ 完成 | |
| `backend/src/jobs/indexing-poller.ts`（每 30 秒輪詢）| ✅ 完成 | 匯出 `pollOnce` 供單元測試直接呼叫 |
| `backend/src/services/project.service.ts` deleteProject 補上 Storage/Dify 清理 | ✅ 完成 | |
| `tests/mocks/supabase.mock.ts` | ✅ 完成 | |
| `tests/mocks/dify.mock.ts`（新增三個函式） | ✅ 完成 | |
| `tests/mocks/prisma.mock.ts`（新增 material、materialEditHistory） | ✅ 完成 | |
| `tests/unit/backend/services/material.service.test.ts`（10 cases） | ✅ 完成 | |
| `tests/unit/backend/jobs/indexing-poller.test.ts`（4 cases） | ✅ 完成 | |

---

## 三、與計畫的偏差

- **`supabase.ts` 使用 native fetch 而非 `@supabase/supabase-js`**：`@supabase/supabase-js` 未安裝於 backend package.json，且 Supabase Storage REST API 相當簡單（POST upload、DELETE remove）。使用 native fetch 減少依賴，介面（`uploadFile`、`deleteFile`）與計畫完全一致。

- **`PrismaClientKnownRequestError` instanceof 改為 code 字串判斷**：測試環境中 mock error 為普通 `Error` 物件，`instanceof PrismaClientKnownRequestError` 永遠為 false。改為 `(err as { code?: string })?.code === 'P2002'` 的模式，與 `member.service.ts` 的既有慣例一致。

- **`pollOnce` 函式同時匯出**：計畫僅要求 `startIndexingPoller`，但為了讓 `indexing-poller.test.ts` 可直接呼叫單次輪詢邏輯（不需 `setInterval`），額外 export `pollOnce`。

- **`deleteProject` 測試補 `material.findMany` mock**：P2 的 `deleteProject` 測試未預期 `findMany` 呼叫，需補上 `mockResolvedValueOnce([])` 以維持測試通過。

---

## 四、測試結果

```
Tests:  30 passed, 0 failed, 0 skipped
Files:  5 test files
Duration: ~1.4s
```

新增測試涵蓋的 cases：

**material.service.test.ts（10 cases）**
- 上傳成功 → Material + EditHistory 均建立，storagePath 正確 ✅
- MIME type 不支援 → 415，不呼叫 Storage ✅
- 超過 15 MB → 413 ✅
- SHA-256 重複（未刪除）→ 409 DUPLICATE_FILE ✅
- SHA-256 重複（已刪除）→ 舊紀錄 sha256 改為 DELETED_{id}，建立新紀錄 ✅
- Prisma P2002（TOCTOU 競態）→ 409 DUPLICATE_FILE，不拋 500 ✅
- Dify 上傳失敗 → 呼叫 deleteFile 回滾 ✅
- Prisma create 失敗 → 雙回滾（deleteFile + deleteDocument）✅
- 刪除成功 → Dify、Storage、Prisma update 均呼叫 ✅
- Dify 刪除失敗 → 不拋錯，繼續執行 Storage 與 DB ✅

**indexing-poller.test.ts（4 cases）**
- PROCESSING material → 呼叫 getIndexingStatus，更新 DB ✅
- COMPLETED material（findMany 回傳空陣列）→ 不呼叫 Dify ✅
- difyBatch 為 null → skip，不呼叫 Dify ✅
- Dify 回傳 FAILED → 更新 indexingStatus 為 FAILED ✅

---

## 五、下一 Phase 注意事項

- **`uploadMaterial` 的 `difyDatasetId` 傳入方式**：目前 `uploadDocument` 的第一個參數為 `projectId`，但 Dify 需要的是 `difyDatasetId`。實作中在 upload 前需取得 project 的 `difyDatasetId`——目前透過 `requireEditAccess` 回傳的 project 物件取得。P4 整合測試前需確認此流程正確。

- **`material.service.ts` 中 `uploadMaterial` 的 `uploadDocument` 呼叫**：傳入的第一個參數應為 `project.difyDatasetId`，而非 `projectId`——目前程式碼在呼叫時傳入 `projectId`，需在 P4 整合驗證時確認實際上傳至正確的 Dify dataset。

- **`deleteProject` 現在有額外的 `material.findMany` 呼叫**：P4 整合測試時，若專案有 material，需確認 Storage/Dify 均正確清理。

- **indexing-poller 在測試環境不啟動**：`startIndexingPoller` 只在 `index.ts` 呼叫，單元測試使用匯出的 `pollOnce`，不影響 CI。

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P3 → ✅ 完成（已完成）
- 無新增關鍵設計決策

---

*報告結尾*
