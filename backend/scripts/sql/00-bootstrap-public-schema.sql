-- ══════════════════════════════════════════════════════════════════════════════
-- demo 堆疊專用：建立身分層資料表（public.users / public.api_tokens）
-- ══════════════════════════════════════════════════════════════════════════════
--
-- 為什麼需要這一段（2026-08-20 落地時踩到）：
--
-- 這一版（df3eba7，2026-07-20）的身分層仍放在 Vexa 的 `public` schema，
-- CLAUDE.md 寫得很清楚：「public schema ← Vexa 管理，只讀。使用 prisma.$queryRaw 存取」。
-- 也就是說 **Prisma 不負責建立這兩張表**，`prisma db push` 只會建 `app` schema。
--
-- 原本是由 docker-compose 的 `vexa-init-db` 容器呼叫 vexa-lite 的 init_db() 建出來的。
-- demo 用的是全新的獨立資料庫（compose project `meetbot-demo`），沒有人跑過那段初始化，
-- 於是：
--
--     登入 → 前端呼叫 /internal/token → 後端 INSERT INTO public.users → 表不存在 → 500
--          → 拿不到 token → 專案清單 API 401
--          → 畫面顯示「專案清單載入失敗，請重新整理頁面再試一次。」
--
-- 登出再登入不會好，因為每次都卡在同一個地方。
--
-- 欄位定義依據 backend 實際查詢推得，逐一對照過：
--   middleware/auth.ts     SELECT user_id, id, scopes FROM public.api_tokens
--                          WHERE token = ? AND (expires_at IS NULL OR expires_at > NOW())
--                          SELECT id, email, name, max_concurrent_bots FROM public.users
--   routes/internal.ts     INSERT INTO public.users (email, name)
--                          INSERT INTO public.api_tokens (token, user_id, scopes, name)
--   （另有多處 SELECT id, email, name FROM public.users）
--
-- 冪等：表已存在就整段跳過，重複執行安全。

CREATE TABLE IF NOT EXISTS public.users (
  id                  SERIAL PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT,
  -- 併發 bot 上限：auth 中介層每次請求都會讀，NOT NULL 才不會在 TypeScript 端變成 null
  max_concurrent_bots INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.api_tokens (
  id         SERIAL PRIMARY KEY,
  token      TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- scopes 是 text[]：internal.ts 寫入 ARRAY['bot','browser','tx']::text[]
  scopes     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = 永不過期；auth 的條件是 (expires_at IS NULL OR expires_at > NOW())
  expires_at TIMESTAMPTZ
);

-- 登入時「重用未過期 token」會用 user_id 撈最新一筆，補個索引
CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON public.api_tokens (user_id);
