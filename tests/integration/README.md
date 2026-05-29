# Integration Tests（預留目錄）

整合測試會在此目錄下建立，用於驗證跨服務邊界的真實互動。

## 規劃中的測試範疇

| 測試項目 | 涉及系統 | 前提環境 |
|---------|---------|---------|
| DB Migration 驗證 | Supabase PostgreSQL | 需要 `DATABASE_URL` |
| Material 三方 rollback | Supabase Storage + Dify + Prisma | 需要 Storage bucket + Dify API Key |
| 會議建立 + Bot 邀請 E2E | Vexa-lite + Supabase | 需要完整 vexa-lite 運行 |
| 摘要工作流完整流程 | Dify + Supabase Storage + Prisma | 需要 Dify Workflow Key |

## 執行方式（待補）

整合測試需要真實的外部服務，不在 CI 一般流程中自動執行。需手動觸發或在有完整環境設定的環境中執行。

```bash
# 待補：整合測試執行指令
# npx vitest run --config vitest.integration.config.ts
```