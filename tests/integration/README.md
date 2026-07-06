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

## 手動探測腳本（非 vitest）

### `vexa-join-probe.mts` — Vexa bot 加入能力探測

單獨驗證 Vexa bot 進不進得去 Google Meet（撇開 meetbot 後端與 failover），
即時列印 Vexa bot log 中的 admission 相關訊息（reCAPTCHA / 等候室 / 准入），
並給出判定：`ADMITTED` / `BLOCKED-CAPTCHA` / `BLOCKED-WAITING` / `TIMEOUT-UNKNOWN`。

```bash
# 1. 自己先用瀏覽器開好一場 Google Meet 並留在會議中
# 2. 從 backend/ 目錄執行（重用 backend 的 .env 與 node_modules）
cd backend
npx tsx --env-file .env ../tests/integration/vexa-join-probe.mts https://meet.google.com/xxx-xxxx-xxx
# 3. bot 出現在等候室時按「允許加入」；進來後說幾句話驗證轉錄
```

前提：vexa-lite 容器運行中、`backend/.env` 齊全。admission timeout 預設 300 秒（第二個參數可調）。