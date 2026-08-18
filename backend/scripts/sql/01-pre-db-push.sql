-- ══════════════════════════════════════════════════════════════════════════════
-- 一次性遷移（移除 Vexa）· 第一段：db push **之前**執行
-- ══════════════════════════════════════════════════════════════════════════════
--
-- 為什麼需要這一步：本次 schema 變更刪掉 meeting_instances 的兩個純 Vexa 欄位，
-- 其中 creator_api_token_id 是 NOT NULL 且有資料。`prisma db push` 遇到「刪掉有資料
-- 的欄位」會判定為破壞性變更，非互動模式（start.ps1 把它的輸出丟掉）下直接失敗，
-- 而且失敗是**靜默的**——app.users / app.user_tokens 沒被建出來，於是登入 500、全站 401。
--
-- 先在這裡把破壞性差異抹平，db push 就只剩「新增資料表」這種安全變更，不必掛
-- --accept-data-loss（那個旗標會讓未來任何一次誤刪欄位也一起無聲通過）。
--
-- 冪等：欄位已不存在就是 no-op；app schema 尚未建立（全新 DB）時整段跳過。
DO $$
BEGIN
  IF to_regclass('app.meeting_instances') IS NOT NULL THEN
    ALTER TABLE app.meeting_instances DROP COLUMN IF EXISTS vexa_meeting_id;
    ALTER TABLE app.meeting_instances DROP COLUMN IF EXISTS creator_api_token_id;
  END IF;
END $$;
