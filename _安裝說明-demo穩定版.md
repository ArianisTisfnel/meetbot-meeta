# Demo 穩定版　安裝說明

**分支：`demo/stable-0720`　基準 commit：`df3eba7`（2026-07-20）**

比賽影片要錄的版本。從 main 退回到 7/20，因為那是**最後一個有完整驗收紀錄**的狀態。
2026-09-02 已一人多帳號實測跑過一輪，結果見文末。

> **不要直接在既有的 `meetbot-meeta` 資料夾切過來。**
> 這一版的資料庫 schema 與現在的 main 不同，切過去 `prisma db push` 會把你的開發資料庫改掉。
> 請照下面的步驟**另開一個資料夾**，兩邊可以並存。

---

## 一、前置需求

| 項目 | 說明 |
|---|---|
| **Docker Desktop** | 要先啟動 |
| **cloudflared** | `winget install Cloudflare.cloudflared`，裝完**開新的 PowerShell**。<br>就算不用語音也必裝——Recall 的 webhook 需要對外網址才收得到聊天室訊息 |
| Node.js | 20 以上 |

---

## 二、取得程式碼（另開資料夾）

**方法 A：另外 clone 一份**（最單純，推薦）

```powershell
cd D:\grp
git clone https://github.com/ArianisTisfnel/meetbot-meeta.git meetbot-demo
cd meetbot-demo
git switch demo/stable-0720
```

**方法 B：用 worktree**（省磁碟，共用同一份 git 歷史）

```powershell
cd D:\grp\meetbot-meeta
git fetch origin
git worktree add ..\meetbot-demo demo/stable-0720
```

---

## 三、環境變數

三個檔案，都不在 git 裡，要自己準備。**最快的做法是從你現有的 repo 複製過來再改 port。**

```powershell
cd D:\grp\meetbot-demo
copy ..\meetbot-meeta\backend\.env backend\.env
copy ..\meetbot-meeta\frontend\.env frontend\.env
copy ..\meetbot-meeta\frontend\.env.local frontend\.env.local
```

**然後改 `backend\.env` 這幾行**（port 與主 repo 分開，兩邊才能並存）：

```
DATABASE_URL="postgresql://meetbot:meetbot_local_dev@localhost:5434/meetbot"
DIRECT_URL="postgresql://meetbot:meetbot_local_dev@localhost:5434/meetbot"
S3_ENDPOINT="http://127.0.0.1:19002"

RECALL_WEBHOOK_URL=""     ← 清空，start.ps1 每次會自動填
AGENT_PAGE_URL=""         ← 清空，同上
```

**確認這幾項**（錄影用組態）：

```
AGENT_MODE=on
INTERJECTION_ENABLED=true
ICEBREAKER_ENABLED=true
ICEBREAKER_SILENCE_MS=15000
ICEBREAKER_COOLDOWN_MS=300000
INTERJECTION_COOLDOWN_MS=15000
INTERJECTION_TURN_SILENCE_MS=1500
INTERJECTION_TURN_DETECTOR=livekit
```

⚠️ **`GEMINI_INTERJECTION_API_KEY` 請留空。** 詳見「踩雷清單」第 5 條。

---

## 四、啟動

```powershell
cd D:\grp\meetbot-demo
.\start.bat
```

第一次會比較久（兩個目錄 npm install ＋ 拉 Docker image ＋ 下載 LiveKit turn-detector 模型約 150MB）。

`start.ps1` 會依序做完：docker compose → 等 postgres healthy → npm install →
**建立身分層資料表** → `prisma db push` → `prisma generate` → 開 cloudflared 隧道並把網址寫回 `.env` → 啟動前後端。

**啟動後先確認這一行：**

```powershell
docker port meetbot-demo-minio
```

要看到 `9000/tcp -> 0.0.0.0:19002`。**看不到就是踩到雷 1**，往下看。

---

## 五、踩雷清單（我們全部踩過一遍，照這個查最快）

### 1. MinIO 綁不上 port → 檔案上傳失敗 `AggregateError`

**症狀**：上傳知識庫文件時 `Storage upload error: AggregateError`；
`docker ps` 顯示 minio 只有 `9000/tcp` 沒有 `-> 0.0.0.0:19002`。

**原因**：Windows 的 Hyper-V／WSL2 會**動態保留一段 port**，被保留的 port 綁不上，
而且 `netstat` 查不到（因為沒有程式在聽，是「被預約」）。**每次開機重新分配**，所以昨天能用今天不一定。

**查**：

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

**修**：挑一個完全落在所有區段之外的 port，改 `docker-compose.yml` 的 minio ports
與 `backend\.env` 的 `S3_ENDPOINT`，然後：

```powershell
docker compose up -d --force-recreate minio minio-init
docker port meetbot-demo-minio
```

### 2. 登入後「專案清單載入失敗」

**原因**：這一版的身分層（`public.users` / `public.api_tokens`）在 **Vexa 的 public schema，Prisma 不管它**
（見 CLAUDE.md 第 24 行），原本由 `vexa-init-db` 容器建立。這個 demo 用全新獨立資料庫，沒有那個容器。

**已修**：`start.ps1` 第 3.5 節會自動跑 `backend/scripts/sql/00-bootstrap-public-schema.sql`（冪等）。

**如果還是壞**：

```powershell
docker exec meetbot-demo-postgres psql -U meetbot -d meetbot -c "\dt public.*"
```

看不到 `users` / `api_tokens` 就手動補：

```powershell
docker cp backend\scripts\sql\00-bootstrap-public-schema.sql meetbot-demo-postgres:/tmp/bootstrap.sql
docker exec meetbot-demo-postgres psql -U meetbot -d meetbot -f /tmp/bootstrap.sql
```

補完**登出再登入一次**（要重新鑄 token）。

### 3. `start.bat` 卡在 Prisma 不動

**原因**：7/20 的 schema 還有 Vexa 欄位，對著既有資料庫 `db push` 會產生破壞性差異，
prisma 停在互動式確認等你按 y，而 `start.ps1` 把輸出丟掉了，所以畫面上什麼都看不到。

**已修**：改成 `prisma db push --accept-data-loss`（demo 用獨立資料庫，沒有要保的資料）。

### 4. 後端 4000 / 前端 3000 衝突

Docker 那層兩邊已經隔離（project `meetbot-demo`、port 5434/19002/19003/5051），
**但 app 的 4000 與 3000 沒有分開**。跑 demo 前先把主 repo 的 `npm start` 關掉。

### 5. 破冰與插話完全不動，log 一直噴 `icebreaker: LLM failed`

**原因**：`.env` 裡的 `GEMINI_INTERJECTION_API_KEY` 是一把**格式不對的 key**
（`AQ.Ab8RN6...`；Gemini 的 key 一律 `AIza` 開頭），打 `generateContent` 一律回
`400 INVALID_ARGUMENT`。

而 `lib/llm.ts` 的判斷是 `purpose === 'interjection' && env.GEMINI_INTERJECTION_API_KEY`
——**只看「有沒有設」，不看「能不能用」**，所以壞 key 一設就永遠不會退回主 key。

**修**：把 `GEMINI_INTERJECTION_API_KEY` 留空，讓它退回 `GEMINI_API_KEY`。

⚠️ 副作用：插話、破冰、意圖分類會擠在同一把 key 的免費額度上，長會議容易 429。
**錄影前建議準備一把還有額度的 key**，或設 `GEMINI_INTERJECTION_MODEL=gemini-flash-lite-latest`
（那個型號免費層額度較寬，15 RPM／500 RPD）。

### 6. Dify 回 `429` 或 `Collection not found`

- **429（Cloudflare Error 1015）**：chatflow 的 HTTP Request 節點是在 **Dify 雲端**回打自家 API，
  Cloudflare 看到的是 Dify 的共用出口 IP，被別人打爆時我們會被連坐。`retry-after` 通常只有幾秒，
  **等一兩分鐘再試多半就好**。
- **`Collection not found`**：知識庫的向量索引失效（8/18 發生過，文件被停用）。
  去 Dify 後台跑一次「召回測試」確認，必要時重新索引。

### 7. 一鍵開會按了，蜜塔沒進來

**不是 bug。** Google Meet 的快速會議在**沒有主持人在場**時會擋掉外部參加者，
bot 到門口沒人開門，等到 `RECALL_ADMISSION_TIMEOUT_MS`（90 秒）就放棄。

**正確操作**：按一鍵開會 → 新分頁開啟 Meet → **先讓自己進入房間** → 再回前端按「重邀」。
錄影建議直接走手動路徑：自己先開好 Meet 並進去坐著，再回前端貼連結建會議。

---

## 六、驗收

跑 `_煙霧測試-純文字單人版.md`（同一個資料夾）。2026-09-02 的實測結果：

| Phase | 結果 |
|---|---|
| 1 查詢與容錯（11 題） | **10 / 11**（`asdkjhaskdjh` 被分成閒聊，非阻斷性） |
| 2 冷場破冰 | ✅ 通過（`icebreaker: breaking silence via voice` ×7） |
| 3 主動插話 | ✅ 通過，含兩題反向驗證（日常問題、有人要去查 → 都正確不插話） |
| 4 會後摘要 | ✅ 通過，**沒把查詢結果當成會議決議** |

亮點題：

- **`蜜塔 專案總預算多少` → 15,100,000**。這個數字**文件裡從來沒出現過**，
  要跨三場會議紀錄累加（12,800,000 ＋ 350,000 ＋ 1,950,000）
- **`蜜塔 我們對鼎峰承諾的 SLA 是多少` → 開頭直接說「目前沒有承諾 99.9%」**，
  再解釋 99.5% 是標準值、99.9% 列為待決。一般 RAG 會直接答 99.9%

---

## 七、已知限制（這一版還沒有的功能）

這三項是 7/29 之後才做的，**不在這個版本裡**，測不出來不是壞掉：

| 功能 | 說明 |
|---|---|
| **談論她但不回應** | 這版沒有 mention 仲裁——句中只要出現喚醒詞就切後半當問題。<br>「我覺得蜜塔這個功能不錯」→ 她會回答「這個功能不錯」 |
| **沒喊名字的追問** | 聊天室沒有追問窗（語音才有「只叫名字→下一段當問題」的待命窗） |
| **叫停指令（聊天室）** | `STOP_COMMAND_REGEX` 只掛在語音 barge-in 路徑；<br>聊天室打「蜜塔 不用了」，她會把「不用了」當問題去查 |

**因此 demo 劇本刻意避開這三段**，改法見 `_DEMO-劇本-對抗性版.md`。

---

## 八、這個分支相對 `df3eba7` 改了什麼

只有讓它跑得起來的部分，**沒有動任何判準或 prompt**：

| 檔案 | 改動 |
|---|---|
| `docker-compose.yml` | compose project 改 `meetbot-demo`、容器名加 `-demo`、port 改 5434/19002/19003/5051、移除未使用的 vexa volume |
| `start.ps1` | 健康檢查容器名；`db push --accept-data-loss`；新增第 3.5 節 bootstrap 身分層資料表；隧道整併為單一 cloudflared（移植自 `ee17214`） |
| `backend/scripts/sql/00-bootstrap-public-schema.sql` | **新增**：建立 `public.users` / `public.api_tokens`（冪等） |
| `backend/.env.example` | port 改成 demo 用的 |
| `frontend/.../create-meeting-dialog.tsx` | 一鍵開會後**刪除日曆事件**（原本寫於 2026-07-07 但漏了提交，這裡補上） |
| `_*.md` | 版本說明、demo 劇本、煙霧測試腳本、本文件 |
