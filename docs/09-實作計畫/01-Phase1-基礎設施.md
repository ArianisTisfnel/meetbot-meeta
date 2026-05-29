# Phase 1 — 開發基礎設施

|項目|內容|
|----|-----|
|Phase|P1|
|前置條件|**`00-環境設定.md` 所有步驟已完成**（vexa-lite 啟動、app schema + Storage bucket 建立、.env 填寫、prisma db pull + migrate 執行完畢）|
|參考文件|`06-後端架構.md` §一~三、`03-資料庫Schema設計.md` §六~七|

---

## 一、交付物

1. **Monorepo 目錄結構**（`backend/`、`frontend/`）
2. **後端基礎**：Hono server 啟動、Prisma multiSchema 設定、環境變數驗證
3. **資料庫**：`app` schema migration 完成、Vexa `public` schema 以 db pull 同步
4. **Auth Middleware**：token 驗證、scope 注入、統一錯誤格式
5. **`CLAUDE.md`**：根目錄，供後續 Phase 的新聊天室使用

---

## 二、實作順序

### 2.1 目錄建立

```
meetbot/
├── backend/
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/index.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── error-handler.ts
│   │   │   └── logger.ts
│   │   ├── lib/
│   │   │   └── prisma.ts
│   │   └── types/
│   │       └── env.ts
│   ├── prisma/
│   │   └── schema.prisma   ← 從 03-資料庫Schema設計.md §二 直接貼入
│   ├── .env.example
│   └── package.json
└── frontend/               ← 建立目錄，P7 才填入內容
```

### 2.2 package.json 關鍵依賴（backend）

```json
{
  "dependencies": {
    "hono": "^4",
    "@hono/node-server": "^1",
    "@prisma/client": "^5",
    "pino": "^9",
    "zod": "^3"
  },
  "devDependencies": {
    "prisma": "^5",
    "typescript": "^5",
    "tsx": "^4",
    "vitest": "^2",
    "@types/node": "^20"
  }
}
```

> 測試框架選 **Vitest**（與 Vite 同生態，支援 TypeScript 無需額外設定，mock API 簡潔）。

### 2.3 Prisma 設定

1. 將 `03-資料庫Schema設計.md §二` 的完整 Prisma schema 貼入 `backend/prisma/schema.prisma`
2. 啟動 vexa-lite：`docker compose up -d`（確保 `public` schema 已存在）
3. 建立 `app` schema：在 Supabase SQL Editor 執行
   ```sql
   CREATE SCHEMA IF NOT EXISTS app;
   GRANT ALL ON SCHEMA app TO postgres;
   GRANT USAGE ON SCHEMA app TO authenticated;
   ```
4. 同步 Vexa public schema：`npx prisma db pull`（執行後 diff 確認，只保留 User / Meeting / Transcription）
5. 初始 migration：`npx prisma migrate dev --name init_app_schema`

### 2.4 Auth Middleware

實作 `src/middleware/auth.ts`，行為詳見 `06-後端架構.md §四`：
- raw query 查 `public.api_tokens`
- 注入 `vexaUserId`、`vexaToken`、`vexaTokenScopes`、`vexaApiTokenId`、`maxConcurrentBots`
- 匯出 `requireBotScopes()` 輔助函式

### 2.5 Error Handler

實作 `src/middleware/error-handler.ts`，統一回傳 `{ error_code, message, details? }` 格式（`04-API設計.md §二`）。

定義 `AppError` class：
```typescript
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: object
  ) { super(code) }
}
```

### 2.6 Hono Server 骨架

實作 `src/index.ts`，含：
- CORS、Logger、Auth middleware 掛載
- `registerRoutes(app)`（暫時只有 `GET /me` 回傳 401 以驗證 middleware）
- `startIndexingPoller()`（P3 再填入實作，此處 stub）
- `restoreActiveSessions()`（P5 再填入實作，此處 stub）

### 2.7 環境變數驗證（`src/types/env.ts`）

用 Zod 在啟動時驗證必要環境變數，缺少時立即 `process.exit(1)`：

```typescript
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  SUPABASE_STORAGE_BUCKET: z.string(),
  DIFY_API_BASE: z.string().url(),
  DIFY_DATASET_API_KEY: z.string(),
  DIFY_WORKFLOW_API_KEY: z.string(),
  DIFY_SUMMARY_WORKFLOW_API_KEY: z.string(),
  DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY: z.string(),
  ANTHROPIC_API_KEY: z.string(),
  VEXA_WS_URL: z.string().url(),
  APP_PORT: z.coerce.number().default(4000),
  APP_CORS_ORIGINS: z.string().default('http://localhost:3000'),
})

export const env = envSchema.parse(process.env)
```

### 2.8 CLAUDE.md（根目錄）

建立 `meetbot/CLAUDE.md`，包含：
- Tech stack 總覽（Hono/Node.js + Next.js + Prisma + Supabase + Dify + Vexa）
- 雙 schema 架構（`app` 由 Prisma 管理；`public` 只讀，用 raw query）
- 命名慣例（`vexaUserId` 為整數，`id` 為 UUID，camelCase）
- 關鍵設計決策（bot scope 統一預檢、per-session WebSocket、in-memory activeSessions Map）
- 各 Phase 完成狀態（供後續 chat 快速了解進度）

---

## 三、本 Phase 的單元測試

**測試框架**：Vitest  
**Mock 策略**：此 Phase 建立 `tests/mocks/prisma.mock.ts`，使用 `vi.mock()` mock Prisma client

### `tests/mocks/prisma.mock.ts`

```typescript
import { vi } from 'vitest'

export const mockPrisma = {
  $queryRaw: vi.fn(),
}

vi.mock('../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
```

### `tests/unit/backend/middleware/auth.test.ts`

需覆蓋的 cases：
1. 缺少 Authorization header → 401 UNAUTHORIZED
2. token 不存在於 db → 401 UNAUTHORIZED
3. token 已過期（expires_at < now）→ 401 UNAUTHORIZED
4. 有效 token → 正確注入 `vexaUserId`、`vexaToken`、`vexaTokenScopes`
5. `requireBotScopes()`：完整 scope → return null
6. `requireBotScopes()`：缺少 `tx` scope → 403 INSUFFICIENT_SCOPE，details 包含 missing

---

## 四、Definition of Done

- [ ] `npx tsx src/index.ts` 啟動不拋錯，log 顯示 port 4000
- [ ] `GET /me`（無 header）回傳 `401 { error_code: 'UNAUTHORIZED' }`
- [ ] `GET /me`（有效 token）回傳 `200 { vexaUserId, email, ... }`（P2 才完整實作，此 Phase 只需 middleware 運作）
- [ ] `npx prisma migrate status` 顯示 migration 已套用
- [ ] `npx vitest run` 所有測試通過（P1 的 auth.test.ts）
- [ ] `CLAUDE.md` 已建立於根目錄

---

*文件結尾*