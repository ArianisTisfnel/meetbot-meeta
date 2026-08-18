# Integration Tests（預留目錄）

整合測試會在此目錄下建立，用於驗證跨服務邊界的真實互動。

## 規劃中的測試範疇

| 測試項目 | 涉及系統 | 前提環境 |
|---------|---------|---------|
| DB Migration 驗證 | Supabase PostgreSQL | 需要 `DATABASE_URL` |
| Material 三方 rollback | Supabase Storage + Dify + Prisma | 需要 Storage bucket + Dify API Key |
| 會議建立 + Bot 邀請 E2E | Recall.ai + Supabase | 需要 RECALL_API_KEY 與公開 webhook 隧道 |
| 摘要工作流完整流程 | Dify + Supabase Storage + Prisma | 需要 Dify Workflow Key |

## 執行方式

整合測試需要真實的外部服務，不在 CI 一般流程中自動執行。需手動觸發或在有完整環境設定的環境中執行。

```bash
# 從專案根目錄執行
npx vitest run --config vitest.integration.config.ts
```

**前提條件**
- 後端在 `localhost:4000` 運行（`cd backend && npm run dev`）
- `INTERNAL_AUTH_SECRET` 與 `backend/.env` 同值（測試靠它跟後端換 API token）

## 已實作的測試

| 檔案 | 測試項目 | 涉及系統 |
|------|---------|---------|
| `backend-projects.test.ts` | /projects CRUD：401 驗證、GET/POST/DELETE | 後端 API + app schema 身份層 + Prisma |

## 手動探測腳本（非 vitest）

Vexa 時代的 `vexa-join-probe.mts`（探測 bot 進不進得去 Google Meet）已隨 Vexa 一併移除。
Recall 的對應腳本是 `backend/scripts/test-recall-join.ts`：

```bash
cd backend
npx tsx --env-file .env scripts/test-recall-join.ts https://meet.google.com/xxx-xxxx-xxx
```
