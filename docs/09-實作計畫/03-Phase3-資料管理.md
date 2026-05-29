# Phase 3 — 資料管理

|項目|內容|
|----|-----|
|Phase|P3|
|前置條件|P2 完成（Project service、Dify 基礎 client）|
|參考文件|`04-API設計.md` §七、`03-資料庫Schema設計.md` §4.2~4.3、`06-後端架構.md` §六（dify.ts）|

---

## 一、交付物

1. **Supabase Storage client**（`src/lib/supabase.ts`）
2. **Dify client 擴充**：`uploadDocument`、`getIndexingStatus`、`deleteDocument`
3. **Material Service**（上傳三方 rollback、SHA-256 判重、軟刪除）
4. **Background Job**：Dify 索引狀態輪詢（每 30 秒）
5. **路由**：`/projects/:id/materials` + `/projects/:id/history`

---

## 二、實作順序

### 2.1 Supabase Storage Client（`src/lib/supabase.ts`）

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

export async function uploadFile(path: string, buffer: Buffer, mimeType: string): Promise<void>
export async function deleteFile(path: string): Promise<void>
```

建立 mock：`tests/mocks/supabase.mock.ts`

### 2.2 Dify Document 函式（接續 `src/lib/dify.ts`）

```typescript
export async function uploadDocument(datasetId: string, file: {
  buffer: Buffer
  filename: string
  mimeType: string
}): Promise<{ documentId: string; batch: string }>

export async function getIndexingStatus(datasetId: string, batch: string): Promise<{
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  error?: string
}>

export async function deleteDocument(datasetId: string, documentId: string): Promise<void>
```

`uploadDocument` 的 `process_rule` 參數（依 `06-後端架構.md §六`）：
```json
{
  "mode": "hierarchical",
  "rules": {
    "pre_processing_rules": [
      { "id": "remove_extra_spaces", "enabled": true },
      { "id": "remove_urls_emails", "enabled": false }
    ],
    "segmentation": {
      "separator": "\n",
      "max_tokens": 1500
    },
    "subchunk_segmentation": {
      "separator": "。",
      "max_tokens": 500,
      "chunk_overlap": 75
    }
  },
  "doc_language": "Chinese"
}
```

### 2.3 Material Service（`src/services/material.service.ts`）

核心邏輯依 `04-API設計.md §七` 與 `03-資料庫Schema設計.md §4.2~4.3`：

**上傳（`uploadMaterial`）**：
```
① 驗證 MIME type（pdf/docx/txt/md）、大小（≤ 15MB）
② 計算 SHA-256；查 DB 判重（04 §七 的判重邏輯）
③ upload Supabase Storage → path: {projectId}/{uuid}/{filename}
④ upload Dify document → { documentId, batch }
⑤ Prisma create Material（含 difyDocumentId、difyBatch）
⑥ Prisma create MaterialEditHistory（action: UPLOAD）
失敗 rollback：
  ④ 失敗 → 刪 Storage
  ⑤ 失敗 → 刪 Storage + 刪 Dify document
  ⑥ 失敗 → 記 error log（不回滾，補寫策略）
```

**軟刪除（`deleteMaterial`）**：
```
① Dify deleteDocument
② Storage deleteFile
③ Prisma update Material（deletedAt = now()）
④ Prisma create MaterialEditHistory（action: DELETE）
任何步驟失敗：記 error log，標記 material 狀態異常，不對使用者拋錯
```

**SHA-256 判重特殊情況**（`03-資料庫Schema設計.md §4.3`）：
- 存在且未刪除 → 409 DUPLICATE_FILE
- 存在且已刪除 → 更新舊紀錄 sha256 = `DELETED_{id}`，建立新紀錄
- 捕捉 Prisma P2002 → 409 DUPLICATE_FILE（TOCTOU 競態防護）

### 2.4 Indexing Poller（`src/jobs/indexing-poller.ts`）

依 `04-API設計.md §十一 10.1`：每 30 秒查 `indexingStatus IN (PENDING, PROCESSING)` 的 materials，呼叫 Dify getIndexingStatus 更新。

```typescript
export function startIndexingPoller(): void {
  setInterval(async () => {
    // ...（詳見 04-API設計.md §十一）
  }, 30_000)
}
```

---

## 三、本 Phase 的單元測試

### `tests/unit/backend/services/material.service.test.ts`

需覆蓋的 cases：
1. 上傳成功 → Material + EditHistory 均建立，StoragePath 正確
2. MIME type 不支援 → 415 直接拋錯，不呼叫 Storage
3. 超過 15 MB → 413
4. SHA-256 重複（未刪除）→ 409 DUPLICATE_FILE
5. SHA-256 重複（已刪除）→ 舊紀錄 sha256 更新為 DELETED\_{id}，建立新紀錄
6. TOCTOU：Prisma P2002 → 409 DUPLICATE_FILE（確保不拋 500）
7. Dify 上傳失敗（步驟④）→ 刪除 Storage 檔案（rollback 驗證：mockSupabase.deleteFile called）
8. Prisma create 失敗（步驟⑤）→ 刪除 Storage + Dify（雙 rollback 驗證）
9. 刪除成功 → 三方均呼叫（mockDify.deleteDocument、mockSupabase.deleteFile、Prisma update）
10. 刪除 Dify 失敗 → 不拋錯，只記 log（error handler 測試）

### `tests/unit/backend/jobs/indexing-poller.test.ts`

需覆蓋的 cases：
1. PROCESSING material → 呼叫 Dify getIndexingStatus，更新 DB
2. COMPLETED material → 不再輪詢（不在查詢範圍）
3. material.difyBatch 為 null → skip（不呼叫 Dify）
4. Dify 回傳 FAILED → 更新 indexingStatus 為 FAILED

---

## 四、Definition of Done

- [ ] 上傳 PDF 後，Dify Knowledge Base 出現該文件
- [ ] 上傳相同檔案兩次 → 第二次 409 DUPLICATE_FILE
- [ ] 刪除後 Storage、Dify KB、DB 均同步消失
- [ ] 30 秒內 indexingStatus 從 PROCESSING 更新為 COMPLETED（或 FAILED）
- [ ] `npx vitest run` 所有測試通過（含 P1、P2）
- [ ] 更新 `CLAUDE.md` 標記 P3 完成

---

*文件結尾*