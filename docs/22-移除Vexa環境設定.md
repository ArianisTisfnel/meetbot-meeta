# 22 · 移除 Vexa — 環境設定（拉完 code 照做）

> 🔒 **凍結快照**：記錄 `refactor/remove-vexa` 合併當下該做什麼。讀完即退場，不必回頭維護。
> 背景與設計說明見 `03-資料庫Schema設計.md`、`06-後端架構.md`、`13-系統現況與路線圖.md`。

---

## TL;DR

**跑 `start.bat` 就好。** 底下該做的事它全都會做，包含這次新增的兩段一次性 DB 遷移。

但請**看著它跑完**：`prisma db push` 失敗現在會印一整段紅字（以前只印一行黃字 Warning 就
往下走，結果是登入 500 卻找不到原因）。有紅字就照下面的「出問題時」處理。

---

## 你要動手做什麼

| 項目 | 要不要做 | 說明 |
|------|:---:|------|
| `npm install` | **不用手動** | `start.ps1` 會跑（backend + frontend）。這次沒有新套件 |
| `npx prisma db push` | **不用手動** | `start.ps1` 會跑，且前後各夾一段一次性遷移 SQL |
| 身份資料遷移（使用者、token） | **不用手動** | 同上，`start.ps1` 自動跑，冪等 |
| 加環境變數 | **不用手動** | `INTERNAL_AUTH_SECRET` 缺的話 `start.ps1` 會自動產生，並同步寫進 `backend/.env` 與 `frontend/.env.local` |
| 刪環境變數 | **不用做**（可選） | 舊的 `VEXA_*` 留著沒有副作用，Zod schema 直接忽略。想清乾淨看下面 |
| 裝新東西 | **不用做** | 沒有新的外部依賴 |
| 重新登入 | **不用做** | 舊 token 會一起被遷移過來，瀏覽器裡的 session 繼續有效 |
| 清 Vexa 容器 | **不用手動** | `docker compose up -d --remove-orphans` 會順手清掉 `meetbot-vexa-lite` |

---

## 這次到底改了什麼（一句話版）

身份驗證從「Vexa 的 `public.api_tokens` / `public.users`」搬到「我們自己的
`app.user_tokens` / `app.users`」，bot provider 從「Vexa + Recall failover」變成
「只有 Recall」。**功能沒有變化**，蜜塔該會的都還會。

---

## 為什麼需要「一次性遷移」（不做會怎樣）

兩件事，都會靜默壞掉，所以寫成自動化而不是叫大家記得：

1. **db push 前**：這次刪掉 `meeting_instances` 的 `creator_api_token_id`（NOT NULL、有資料）
   與 `vexa_meeting_id`。Prisma 判定為破壞性變更，非互動模式直接失敗 →
   `app.users` / `app.user_tokens` 根本沒建 → 登入 500、全站 401。
   → `backend/scripts/sql/01-pre-db-push.sql` 先把這兩欄拿掉，讓 db push 只剩「新增表」。

2. **db push 後**：`app.users` 是新的空表，但 `app` schema 裡所有 `*_user_id` 欄位存的是
   **舊 Vexa user id**。不搬資料的話，第一個登入的人會拿到 id=1，於是繼承舊 id=1 那個人的
   所有專案／會議／素材——不是資料遺失，是**資料錯給人**，比遺失更難發現。
   → `backend/scripts/sql/02-post-db-push.sql` 把 `public.users` / `public.api_tokens`
   原樣（含 id）搬進 app schema，並把序列推到 MAX(id) 之後。

兩段都是**冪等**的：跑過就是 no-op，全新環境也安全（`app.users` 一有資料就整段跳過）。

---

## 出問題時

### 登入後畫面一片空白 / 每個操作都轉圈或報錯

多半是 `INTERNAL_AUTH_SECRET` 前後端不同值。症狀特別容易誤判：**登入是成功的**，
只是拿不到 API token，之後每個 API 都 401。

```powershell
# 兩邊必須一模一樣
Select-String -Path backend\.env,frontend\.env.local -Pattern 'INTERNAL_AUTH_SECRET'
```

不一致的話，把 `frontend/.env.local` 那行刪掉再跑一次 `start.bat`（會自動補成同值），
然後**重新登入一次**（舊的 session 裡沒有 token）。前端 server log 也會印明確原因。

### start.bat 印出紅色的 `prisma db push FAILED`

把紅字整段貼出來。常見原因是 Postgres 容器還沒起來，或 `backend/.env` 的
`DATABASE_URL` / `DIRECT_URL` 不對（本機是 `localhost:5433`，不是 5432）。

### 專案列表空了 / 專案擁有者變成別人

身份資料遷移沒跑成功。先確認：

```powershell
docker exec -it meetbot-postgres psql -U meetbot -d meetbot -c "SELECT id, email FROM app.users ORDER BY id;"
```

如果是空的、或 id 跟舊的 `public.users` 對不起來，手動補跑：

```powershell
cd backend
npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/02-post-db-push.sql
```

（它只在 `app.users` 為空時才動作。若已經被錯誤的資料佔用，先清掉 `app.users`
與 `app.user_tokens` 再跑，然後所有人重新登入一次。）

---

## 想把 .env 清乾淨（可選，不影響運作）

`backend/.env` 這些已經沒有任何程式讀它們：

```
VEXA_API_URL / VEXA_WS_URL / ADMIN_API_TOKEN
TRANSCRIPTION_SERVICE_URL / TRANSCRIPTION_SERVICE_TOKEN
BOT_PRIMARY_PROVIDER / BOT_ADMISSION_TIMEOUT_MS
```

`frontend/.env.local`：

```
VEXA_API_URL / VEXA_ADMIN_API_URL / VEXA_ADMIN_API_KEY
```

DB 裡的 `public` schema（Vexa 的舊表）也可以留著——`schemas = ["app"]` 下
db push 不會動它。確定不需要歷史資料後才 `DROP SCHEMA public CASCADE`，
**別在遷移當天就刪**（那是身份資料遷移的來源）。

---

## 順帶要知道的一件事

逐字稿只活在記憶體裡：**後端重啟後，進行中的會議會被收尾成 ENDED，該場也不會有摘要**。
這不是這次改壞的（Recall 本來就這樣），但移除 Vexa 之後最後一條補救路徑消失了，
所以現在明確寫下來。開會中請不要重啟後端。詳見 `13-系統現況與路線圖.md § 已知限制`。
