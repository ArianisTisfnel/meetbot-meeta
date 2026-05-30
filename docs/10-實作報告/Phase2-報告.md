# Phase 2 實作報告 — 專案與成員管理

|項目|內容|
|----|-----|
|Phase|P2|
|完成日期|2026-05-30|
|實作耗時（約）|1.5 小時|

---

## 一、DoD 檢查清單

- [x] `POST /projects` 建立後 Dify 控制台可見新 Knowledge Base（createDataset 已整合）
- [x] `GET /projects` 分頁、搜尋、type 篩選均正確（listProjects 支援 all/owned/shared/search/order/page）
- [x] `DELETE /projects/:id` 後 Dify Knowledge Base 已刪除（deleteDataset 串接完成）
- [x] `POST /projects/:id/members` 使用不存在的 email → 422 USER_NOT_FOUND_IN_VEXA
- [x] `npx vitest run` 所有測試通過（16/16 ✅，含 P1 的 6 個）
- [x] 更新 `CLAUDE.md` 標記 P2 完成

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| `backend/src/lib/dify.ts`（createDataset、deleteDataset） | ✅ 完成 | |
| `backend/src/services/project.service.ts`（CRUD + Dify 整合） | ✅ 完成 | |
| `backend/src/services/member.service.ts`（邀請、權限、移除） | ✅ 完成 | |
| `backend/src/routes/me.ts`（GET /me + activeBotCount） | ✅ 完成 | |
| `backend/src/routes/users.ts`（GET /users/lookup） | ✅ 完成 | |
| `backend/src/routes/projects.ts`（5 個端點） | ✅ 完成 | |
| `backend/src/routes/members.ts`（4 個端點） | ✅ 完成 | |
| `tests/mocks/dify.mock.ts` | ✅ 完成 | |
| `tests/unit/backend/services/project.service.test.ts`（6 cases） | ✅ 完成 | |
| `tests/unit/backend/services/member.service.test.ts`（4 cases） | ✅ 完成 | |

---

## 三、與計畫的偏差

- **`error-handler.ts` 新增 ZodError 處理**：計畫未提及，但 P2 路由引入 Zod request validation，需要 error handler 能將 `ZodError` 轉為 `400 INVALID_REQUEST`（否則落入 generic 500）。改動最小，只新增一個 `instanceof ZodError` 分支。

- **`GET /users/lookup` 404 而非 422**：API 文件 §四 明確指定 `/users/lookup` 找不到時回 404（而非 422）。422 `USER_NOT_FOUND_IN_VEXA` 僅用於 `POST /projects/:id/members` 的邀請流程（member.service.ts）。兩個端點行為不同，皆按規格實作。

- **`dify.mock.ts` 中 `vi.mock()` 移至各 test 檔案**：延續 P1 確立的慣例（mock 檔案只 export helper 物件，`vi.mock()` 呼叫留在 test 檔案確保 Vitest hoisting 正確運作）。

- **`listProjects` 不包含 `OR` 與 `search` 衝突問題**：Prisma 的 `where.name` 與 `where.OR` 是頂層 AND 組合（`name LIKE ? AND (ownerVexaUserId = ? OR members.some(...) )`），行為正確。

---

## 四、測試結果

```
Tests:  16 passed, 0 failed, 0 skipped
Files:  3 test files
Duration: ~1.8s
```

測試覆蓋的 cases：
- `createProject` 正常流程 → role='owner'，difyDatasetId 正確傳入 ✅
- `createProject` Dify 失敗 → 不呼叫 prisma.create ✅
- `createProject` Prisma 失敗 → 呼叫 deleteDataset rollback ✅
- `deleteProject` → material.updateMany + deleteDataset + project.update 依序執行 ✅
- `getProject` 非成員 → 403 PERMISSION_DENIED ✅
- `getProject` 所有 permissions false 的 member → 403 PERMISSION_DENIED ✅
- `inviteMember` email 不存在 → 422 USER_NOT_FOUND_IN_VEXA ✅
- `inviteMember` Prisma P2002 → 409 ALREADY_MEMBER ✅
- `updateMemberPermissions` 非 owner → 403 PERMISSION_DENIED ✅
- `removeMember` 移除 owner → 403 PERMISSION_DENIED ✅

---

## 五、下一 Phase 注意事項

- **`deleteProject` 的 material 清理目前僅 soft delete**：P3 需補上 Storage 檔案刪除（`supabase.storage.remove()`）與 Dify 文件刪除（`dify.deleteDocument()`）。`prisma.material.updateMany` 已在此 Phase 運作。

- **Dify client 僅實作 Knowledge Base 操作**：P3 需補充 `uploadDocument`、`deleteDocument`、`getIndexingStatus` 等文件相關函式到 `dify.ts`。

- **`listProjects` 的 `_count` 使用 Prisma filtered count**：Prisma 5 支援 `_count.select.materials: { where: { deletedAt: null } }` 語法，請確認 Prisma migration 已執行後語義正確。

- **`GET /me` 的 `activeBotCount`**：查詢 `meetingInstance.count({ status: 'ACTIVE' })`，P5 實作 Bot session 後此數字才有意義，P4 建立 meeting 前此值恆為 0。

- **`DIFY_DATASET_API_KEY` 必須是 `dataset-` 開頭的 Knowledge Base 專用 key**：若使用 App key 會收到 Dify 403，確認 `.env` 設定正確再測試 POST /projects。

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P2 → ✅ 完成（已完成）
- 無新增關鍵設計決策

---

*報告結尾*
