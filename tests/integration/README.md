# Integration Tests（預留目錄）

整合測試會在此目錄下建立，用於驗證跨服務邊界的真實互動。

## 規劃中的測試範疇

| 測試項目 | 涉及系統 | 前提環境 |
|---------|---------|---------|
| DB Migration 驗證 | Supabase PostgreSQL | 需要 `DATABASE_URL` |
| Material 三方 rollback | Supabase Storage + Dify + Prisma | 需要 Storage bucket + Dify API Key |
| 會議建立 + Bot 邀請 E2E | Vexa-lite + Supabase | 需要完整 vexa-lite 運行 |
| 摘要工作流完整流程 | Dify + Supabase Storage + Prisma | 需要 Dify Workflow Key |

## 執行方式

整合測試需要真實的外部服務，不在 CI 一般流程中自動執行。需手動觸發或在有完整環境設定的環境中執行。

```bash
# 從專案根目錄執行
npx vitest run --config vitest.integration.config.ts
```

**前提條件**
- `docker ps` 可見 `vexaai/vexa-lite:latest` 容器正在運行
- 後端在 `localhost:4000` 運行（`cd backend && npm run dev`）
- `.env.local` 含有 `VEXA_ADMIN_API_KEY`（預設 `my-local-admin-token-2026`）

## 已實作的測試

| 檔案 | 測試項目 | 涉及系統 |
|------|---------|---------|
| `vexa-auth.test.ts` | docker exec Admin API：建立/取得 user、建立 token | vexa-lite Admin API（docker exec） |
| `backend-projects.test.ts` | /projects CRUD：401 驗證、GET/POST/DELETE | 後端 API + Vexa Auth + Prisma |