# Demo 版本說明

**基準 commit：`df3eba7`（2026-07-20）**
`fix(agent): gate isAgentLive on transcription health to avoid deaf-bot (#10)`

這是 main 上**語意層那波（7/29 PR #12–#15）之前的最後一個 commit**。

---

## 為什麼選這一個

| 項目 | 狀態 |
|---|---|
| 插話決策（`INTERJECTION_DECISION_SYSTEM`）＋ 16 個劇本 | ✅ 有 —— 7/07 驗收 **16/16＝100%，0 誤插話 0 漏插話** 的那一版 |
| 離線評測工具 `eval-interjection.ts` | ✅ 有 |
| 沉默破冰（罐頭開場＋會中總結） | ✅ 有 |
| 意圖分流、喚醒詞容錯、叫停 | ✅ 有（在 `wake-word-detector.ts` 內，尚未拆出獨立檔） |
| 本機 Docker（postgres＋MinIO） | ✅ 有（7/14 遷移後） |
| cloudflared agent 網頁、語音延遲修正 | ✅ 有（7/20） |
| 逐字稿重新轉錄、whisper-service | ✅ 有（7/16） |
| **四合一語意層 `TURN_DECISION_SYSTEM`** | ❌ **沒有** |
| **`response-policy.ts`、`addressing.ts`** | ❌ **檔案根本還不存在**（7/29 才生出來） |
| Vexa 移除 | ❌ 尚未（Recall 仍是主要 provider，Vexa 只是 failover） |

**一句話：插話功能完整、基礎設施齊全、語意層還沒出現。**

---

## 怎麼跑起來

**環境已經接好了**（2026-08-20 縫合，見下方「已做的落地修正」）。直接：

```powershell
cd D:\grp\meetbot-demo
.\start.bat
```

`start.ps1` 會自己做完：docker compose → 等 postgres healthy → npm install →
`prisma db push` → `prisma generate` → 開 cloudflared 隧道並把網址寫回 `.env` → 啟動前後端。

### 已做的落地修正

| # | 問題 | 處理 |
|---|---|---|
| 1 | **`start.bat` 卡在 prisma** | 7/20 的 schema 還有 Vexa 欄位，對著現有資料庫 `db push` 會產生破壞性差異 → prisma 停在互動式確認 → 腳本卡死。改成 **`prisma db push --accept-data-loss`**（demo 用獨立資料庫，沒有要保的資料） |
| 2 | **與主 repo 搶同一組容器與資料庫** | 兩邊 compose project 名都叫 `meetbot`，等於共用容器、volume、schema。demo 改成獨立堆疊：project `meetbot-demo`、容器 `meetbot-demo-*`、**port 5434 / 9002 / 9003 / 5051**、volume 自動隔離 |
| 3 | 健康檢查抓錯容器 | `docker inspect meetbot-postgres` → `meetbot-demo-postgres` |
| 4 | **要申請 ngrok 帳號與固定網域** | 把你 8/02 的隧道整併（`ee17214`）縫進來：**一條 cloudflared 同時供應 webhook 與 agent 網頁**，網址自動寫回 `.env`，`RECALL_WEBHOOK_TOKEN` 沒設會自動產生。ngrok 降為退路 |
| 5 | `.env` 要手動改 | `backend/.env`、`frontend/.env`、`frontend/.env.local` 已從主 repo 複製並改好 port；`RECALL_WEBHOOK_URL` 與 `AGENT_PAGE_URL` 清空，交給 `start.ps1` 每次自動填 |
| 6 | **登入後「專案清單載入失敗」** | 這一版的身分層（`public.users` / `public.api_tokens`）**在 Vexa 的 public schema，Prisma 不管它**（CLAUDE.md 第 24 行），原本由 `vexa-init-db` 容器建立。demo 是全新獨立資料庫，沒有那個容器 → 表不存在 → 登入時 `/internal/token` 500 → 專案清單 401。新增 `backend/scripts/sql/00-bootstrap-public-schema.sql` 並在 `start.ps1` 第 3.5 節自動執行（冪等） |

### 如果又出現「專案清單載入失敗」

表沒建起來。先確認：

```powershell
docker exec meetbot-demo-postgres psql -U meetbot -d meetbot -c "\dt public.*"
```

看得到 `users` 與 `api_tokens` 就正常。看不到就手動補：

```powershell
cd D:\grp\meetbot-demo
docker cp backend\scripts\sql\00-bootstrap-public-schema.sql meetbot-demo-postgres:/tmp/bootstrap.sql
docker exec meetbot-demo-postgres psql -U meetbot -d meetbot -f /tmp/bootstrap.sql
```

補完**登出再登入一次**（要重新鑄 token）。

其他排查點：

| 症狀 | 看哪裡 |
|---|---|
| 後端主控台有 `zod` 驗證錯誤 | `backend/.env` 少必填項，後端根本沒起來 |
| 瀏覽器 Network 顯示 401 | token 沒鑄成功 → 看後端 log 有無 `internal-token: created user` |
| 瀏覽器 Network 顯示 500 | 多半就是 `public.users` 不存在 |
| 前端連不上 4000 | 主 repo 的 `npm start` 還開著，佔住 port |

### Port 對照

| 服務 | 主 repo | **demo** |
|---|---|---|
| Postgres | 5433 | **5434** |
| MinIO S3 | 9000 | **9002** |
| MinIO Console | 9001 | **9003** |
| pgAdmin | 5050 | **5051** |
| 後端 / 前端 | 4000 / 3000 | 4000 / 3000（**相同**） |

⚠️ **Docker 那層可以兩邊同時開，但 app 不行**——後端 4000、前端 3000 沒分開。
跑 demo 前先把主 repo 的 `npm start` 關掉。

### 前置需求

- **cloudflared**：`winget install Cloudflare.cloudflared`，裝完**開新的 PowerShell**
- Docker Desktop 先啟動
- 必填環境變數已在 `backend/.env`（Recall、Dify 四把 key、Anthropic、Gemini 都有值，已驗證）。
  要語音才需要 `OPENAI_API_KEY`；`AGENT_MODE=on` 已設好

⚠️ **知識庫**：Dify 的向量索引在 2026-08-18 掛過一次（`Collection not found`，文件被停用）。
Demo 前先在 Dify 跑一次「召回測試」確認知識庫是活的。

---

## Demo 劇本建議（比賽影片用）

目標：**3–5 分鐘、一鏡到底、只展示穩定的路徑。**
刻意避開已知不穩的：語音播放中叫停、長逐字稿 QA、以及任何需要 20 秒以上等待的查詢。

建議用**聊天室打字**為主、語音為輔——打字路徑反應在 1 秒內，畫面節奏好看很多。

| # | 情境 | 台詞 | 展示什麼 |
|---|---|---|---|
| 1 | 開場冷場 | （進會議後靜默 40 秒不說話） | **主動破冰**：蜜塔自己開口邀請大家提問 |
| 2 | 喚醒＋事實查詢 | 「蜜塔 正式上線日是哪一天」 | 知識庫檢索、答案精準、100 字內 |
| 3 | 沒喊名字的追問 | 「那 Beta 呢」 | 接得住省略主詞的追問 |
| 4 | 談論她但不是叫她 | 「我覺得蜜塔這個功能還蠻厲害的」 | **不誤觸發**——她安靜 |
| 5 | **主動插話（主打）** | A：「我們預算到底多少啊？」<br>B：「等等要不要訂飲料」<br>C：「好啊我要冰美式」 | 問題被閒聊蓋過去 → **蜜塔主動補上答案** |
| 6 | 叫停 | 「蜜塔 不用了」 | 立刻閉嘴，不再追問 |
| 7 | 會後摘要 | （結束會議） | 自動產出摘要、決議、待辦 |

第 5 段是整支影片的重點，也是這個專題最有記憶點的功能——
**「沒有人叫她，但她知道有個問題沒人回答」**。拍的時候讓閒聊自然一點，效果最好。

錄之前先照這個順序空跑一次，把每一句的實際反應時間記下來，剪片時才知道哪裡要加速。

---

## 之後要補回來的東西（prompt engineering 強化）

分三類，難度不同：

### A. 可直接用（Dify 那側，與程式版本無關）

| 項目 | 檔案 | 做法 |
|---|---|---|
| RAG chatflow v3.4 | `D:\grp\edu2-v3.yml` | Dify 匯入 → 發布 → `.env` 換 `DIFY_WORKFLOW_API_KEY` |
| 摘要 workflow（不再把查詢結果當決議） | `D:\grp\meeting-summary-v2.yml` | 同上 |

**這兩個沒有相容性問題，補進來只有好處。**

### B. 可移植（檔案在這版也存在，改幾行就好）

| 項目 | 目標檔案 | 內容 |
|---|---|---|
| 防幻覺禁區 | `backend/src/sessions/wake-word-detector.ts` | 在逐字稿 QA、hybrid 合成、chitchat 三處 system prompt 各加一段「不可自行補充蜜塔自身的架構／模組／參數／門檻」 |
| 評測與線上呼叫對齊 | `backend/scripts/eval-interjection.ts` | 補 `temperature: 0` 與 `purpose: 'interjection'`，否則評測數字與線上不可比 |

### C. 要重寫（prompt 結構不同，不能直接貼）

新版的改動全部寫在 `TURN_DECISION_SYSTEM` 的 ①②③④ 分段裡，
而這一版是單純的 `INTERJECTION_DECISION_SYSTEM`，**沒有那個分段結構**。以下要按新結構的意思重新寫進舊 prompt：

| 項目 | 原本寫在哪 | 要點 |
|---|---|---|
| 意見型插話放寬 | ④ 段 | 徵詢全場的意見／評估型問題也該補，但**只在沒有人回應那個問題時**成立 |
| 有人在連續報告中不插話 | ④ 段 | 同一人連續佔多則、且最後一則仍是報告內容 → false；收尾詞（以上、講完了）解除 |
| 最後一則是半句不插話 | ④ 段 | 以連接詞／助詞收尾 → 他還沒講完；但附和與沉吟不算半句 |
| 反例示例 | ④ 段 | 「等等中午要吃什麼？」→ false；「欸那個東西後來怎麼樣了？」→ false |

**建議做法**：先不要動，把 demo 錄完再說。
真的要補，一次補一項，每補一項就跑一次 `eval-interjection.ts` 對照 16/16 的基準，
確認沒退步再補下一項。

---

## 這個資料夾與主 repo 的關係

它是 `git worktree`，與 `D:\grp\meetbot-meeta` 共用同一份 git 歷史，
目前處於 **detached HEAD**（沒有分支）。

要在這裡開發，先給它一個分支：

```powershell
cd D:\grp\meetbot-demo
git switch -c demo/stable-0720
```

不需要了就移除（檔案不會被刪，只是解除登記）：

```powershell
cd D:\grp\meetbot-meeta
git worktree remove ..\meetbot-demo
```
