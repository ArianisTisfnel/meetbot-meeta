-- ══════════════════════════════════════════════════════════════════════════════
-- 一次性遷移（移除 Vexa）· 第二段：db push **之後**執行
-- ══════════════════════════════════════════════════════════════════════════════
--
-- 把身份資料從 Vexa 的 public.users / public.api_tokens 搬進 app.users / app.user_tokens。
--
-- 為什麼非做不可（這不是「錦上添花」）：app schema 裡每一個 *_user_id 欄位
-- （owner_vexa_user_id、vexa_user_id、created_by_vexa_user_id、uploaded_by_vexa_user_id、
-- actor_vexa_user_id、invited_by_vexa_user_id…）存的都是 Vexa public.users.id。
-- @map 保住了欄位名稱，但**沒有**保住這些 id 指向誰。app.users 若留空，
-- 第一個登入的人會拿到 id=1，於是繼承舊 id=1 那個人的所有專案／會議／素材。
-- 這不是資料遺失，是資料錯給人——比遺失更難發現。
--
-- 連 api_tokens 一起搬的理由：組員瀏覽器裡的 NextAuth JWT 存的是舊 token，
-- 一起搬過來就不必全員重新登入（也不會出現「登入著但每個 API 都 401」的狀態）。
--
-- 冪等：app.users 只要已有任何一列就整段跳過。全新 DB（沒有 public.users）也跳過。
DO $$
BEGIN
  IF to_regclass('app.users') IS NULL THEN
    RAISE NOTICE 'app.users 不存在（db push 沒跑成功？）→ 跳過身份資料遷移';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.users) THEN
    RAISE NOTICE 'app.users 已有資料 → 跳過身份資料遷移（本段為一次性）';
    RETURN;
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE '找不到 public.users（全新環境，本來就沒有 Vexa 資料）→ 跳過';
    RETURN;
  END IF;

  -- id 必須原樣保留：app schema 的所有邏輯 FK 都指著這些數字。
  INSERT INTO app.users (id, email, name, max_concurrent_bots, created_at)
  SELECT id, email, name, COALESCE(max_concurrent_bots, 1), COALESCE(created_at, NOW())
  FROM public.users
  ON CONFLICT (id) DO NOTHING;

  -- 序列必須推到 MAX(id) 之後，否則下一個新使用者會撞既有 id。
  PERFORM setval(
    pg_get_serial_sequence('app.users', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM app.users), 1)
  );

  IF to_regclass('public.api_tokens') IS NOT NULL THEN
    INSERT INTO app.user_tokens (token, user_id, expires_at, created_at)
    SELECT t.token, t.user_id, t.expires_at, COALESCE(t.created_at, NOW())
    FROM public.api_tokens t
    WHERE (t.expires_at IS NULL OR t.expires_at > NOW())
      AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = t.user_id)
    ON CONFLICT (token) DO NOTHING;

    PERFORM setval(
      pg_get_serial_sequence('app.user_tokens', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 1) FROM app.user_tokens), 1)
    );
  END IF;

  RAISE NOTICE '身份資料遷移完成：app.users % 列、app.user_tokens % 列',
    (SELECT COUNT(*) FROM app.users), (SELECT COUNT(*) FROM app.user_tokens);
END $$;
