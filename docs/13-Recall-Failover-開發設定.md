🟢 活文件

# Recall Failover + 即時問答 — 開發者設定

> 這份只講 **Recall failover 與即時語音/聊天問答** 需要的額外設定。
> Vexa / Supabase / Dify / 前端的基本設定請看 [README.md](../README.md)。
> 2026-07 起後續新增的設定（LLM 供應商切換、插話、破冰、Prisma CLI 連線）整理在**第七節之後**，速查與除錯表在最後。

## 這是什麼

- **Failover**：Vexa 派 bot 被 Google Meet 擋在門外（API 回 200 但沒進會議）時，後端自動 fallback 到 **Recall.ai**。上層程式不需知道用的是哪家。
- **即時問答**：Recall bot 進會議後，使用者講「蜜塔…」或在聊天室打「蜜塔…」，蜜塔會即時去 Dify 查答案並用**語音或聊天**回覆。

沒設定 Recall 也能跑——系統會只用 Vexa（不 failover）。所以以下都是 **optional**，但要測 Recall 就得做。

---

## 一、需要的帳號 / 金鑰

| 服務 | 用途 | 必需性 |
|------|------|--------|
| [Recall.ai](https://recall.ai) | failover 的第二家 bot provider | 要 failover 才需要 |
| [OpenAI](https://platform.openai.com) | Recall bot 語音回答的 TTS（text→mp3） | 要「語音」回答才需要（聊天文字不用） |
| [ngrok](https://ngrok.com)（免費） | 讓 Recall 的即時 webhook 打得進你本機 | 要 Recall「即時問答」才需要 |

---

## 二、`.env` 設定

複製 `backend/.env.example` → `backend/.env`，除了基本變數外，填入 Recall 區段（範例檔已有註解）：

```env
RECALL_API_URL="https://ap-northeast-1.recall.ai"   # 你的 Recall region
RECALL_API_KEY="..."
OPENAI_API_KEY="sk-..."                              # 語音回答用
RECALL_WEBHOOK_URL="https://你的固定網域.ngrok-free.dev"  # 見下方 ngrok 步驟
RECALL_WEBHOOK_TOKEN="自訂一組隨機字串"               # webhook 共享密鑰
```

> 改完 `.env` 要**重啟 backend** 才生效（dev 沒有 watch）。

---

## 三、ngrok 設定（每個開發者各自做一次）

**為什麼需要**：Recall 的即時逐字稿/聊天是「Recall 主動 POST 進來」，你的後端跑在 `localhost:4000`，外網進不來，所以要一條固定的公開 tunnel。**每個開發者要有自己的**（各自的網域 + authtoken + 各自的 `.env`）。

1. 註冊 ngrok，到 [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) 複製 authtoken。
2. 綁定（只需一次，存在本機 ngrok 設定檔，不在專案內）：
   ```powershell
   tools\ngrok.exe config add-authtoken <你的-authtoken>
   ```
   （`tools\ngrok.exe` 已隨專案附帶；沒有的話到 ngrok 官網下載放進 `tools\`）
3. 到 [Domains](https://dashboard.ngrok.com/domains) → **New Domain**，領一個**免費固定網域**（如 `xxxx.ngrok-free.dev`）。
4. 把它填進 `backend/.env` 的 `RECALL_WEBHOOK_URL`（含 `https://`）。
5. 設一組隨機 `RECALL_WEBHOOK_TOKEN`。

完成後，`start.ps1` 會自動從你的 `.env` 讀這個網域去開 ngrok。

---

## 四、啟動

```powershell
.\start.ps1
```

會依序啟動：**Docker(Vexa) → ngrok → 後端(4000) → 前端(3000)**。
ngrok 在獨立的最小化視窗執行；要單獨停它 `Stop-Process -Name ngrok`。

> 不想用 `start.ps1` 也可手動：各自 `npm run dev`（backend / frontend）+
> `tools\ngrok.exe http --url=<你的網域> 4000`。

---

## 五、沒設定會怎樣（graceful degradation）

| 沒設的東西 | 影響 |
|------------|------|
| `RECALL_API_URL/KEY` | 不啟用 failover，只用 Vexa |
| `RECALL_WEBHOOK_URL/TOKEN` 或 ngrok 沒開 | Recall 仍能進會議 + 會後逐字稿，但**沒有即時喚醒詞問答** |
| `OPENAI_API_KEY` | Recall 即時問答能用**聊天文字**回，但**不能語音**回 |

---

## 六、正式部署備註

**ngrok 只是「本機開發」的克難手段。** 一旦後端部署到有固定公開網址的伺服器（Render / Railway / 雲主機），就**完全不需要 ngrok**——把 `RECALL_WEBHOOK_URL` 改成伺服器網址即可，對所有人生效。

## 已知限制（v1）

- 只做 **join-time failover**，不做 mid-meeting failover（會議中途 provider 死掉不補位）。
- 後端重啟後**無法復原跑在 Recall 上的 session**（DB 只持久化 Vexa 識別碼）。
- ngrok 免費 quick tunnel 會掉線；用上面的「固定網域」可避免換網址，但程序仍需保持執行。

---

## 七、後續新增的 `.env` 設定（2026-07 起）

> 以下是 Recall failover 之後陸續加入的設定，完整定義見 `backend/src/types/env.ts`（zod schema，啟動時驗證）。
> 同樣：**改完 `.env` 要重啟 backend 才生效**。

### 7-1. Prisma CLI 連線（`DIRECT_URL`）

```env
# Prisma CLI 專用（db execute / migrate / db pull）：走 5432 session pooler
DIRECT_URL="postgresql://postgres.[PROJ]:[PWD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
```

- App 執行期照舊走 `DATABASE_URL`（6543 transaction pooler）不變。
- **為什麼要分兩條**：transaction pooler(6543) 跑 DDL 會被 pgbouncer 斷線（錯誤碼 **P1017**）。schema 已設 `directUrl`，CLI 會自動選這條，不用手動切。

### 7-2. LLM 供應商切換（Gemini ↔ Claude）

```env
# 設了就整批改走 Gemini（AI Studio 免費額度：aistudio.google.com/apikey）
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash   # 預設值；推論時關閉 thinking 求快
```

- 影響範圍：**問題意圖分類、閒聊直答、插話決策、破冰、無知識庫的逐字稿 QA**（所有走 `completeText` 的輕量呼叫）。
- 未設 `GEMINI_API_KEY` → 自動走 Claude（`ANTHROPIC_API_KEY`，短輸出 Haiku、長輸出 Sonnet，需儲值）。
- 想換回 Claude：把 `GEMINI_API_KEY` 那行註解掉重啟即可。

### 7-3. 主動插話（interjection）— 🧪 測試階段，目前關閉

```env
INTERJECTION_ENABLED=false          # 總開關
INTERJECTION_TURN_DETECTOR=livekit  # silence=純停頓計時；livekit=EOU 模型語意判斷
INTERJECTION_TURN_SILENCE_MS=2500   # 停頓多久視為一輪話結束
INTERJECTION_EOU_CHECK_MS=1000      # livekit 模式：靜默多久先問 EOU 模型
INTERJECTION_EOU_LANGUAGE=zh        # EOU 閾值查表語言碼
INTERJECTION_EOU_THRESHOLD=0.1      # 閾值（實測講完 ≥0.68、沒講完 ≤0.008；0.1 保守）
INTERJECTION_COOLDOWN_MS=90000      # 兩次插話最小間隔，防話癆
```

- `livekit` 模式**首次啟用會下載 ~150MB 模型**到 `backend/models/`（LiveKit turn-detector，本機 ONNX 推論 ~40ms）。
- 模型不可用時自動退回停頓計時——增強不是依賴。
- 同一顆 EOU 模型也用在**會後逐字稿斷句**（2–8 秒停頓判斷是否分行），無需額外設定。

### 7-4. 沉默破冰（icebreaker）— 🧪 測試階段，目前關閉

```env
ICEBREAKER_ENABLED=false      # 總開關
ICEBREAKER_SILENCE_MS=40000   # 全場靜默多久觸發
ICEBREAKER_COOLDOWN_MS=300000 # 冷卻 5 分鐘
```

### 7-5. 知識庫摘要卡（免設定，自動）

沒有對應環境變數——文件在 Dify 索引完成後，背景工作（60 秒一輪）會自動用 LLM 產 50–120 字的內容摘要存進 DB（`materials.content_card`），供**問題意圖分類器**判斷「這題知識庫答不答得出」。舊文件會自動回填。

### 7-6. 前端 `frontend/.env.local`（參考）

| 變數 | 說明 |
|------|------|
| `NEXT_PUBLIC_API_URL` | 後端位址，預設 `http://localhost:4000` |
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` | NextAuth 回呼 base（本機 `http://localhost:3000`）與 session 加密字串 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth 登入（GCP Console 建立 OAuth Client） |
| `VEXA_API_URL` | Vexa API（登入時建立/查詢 Vexa user） |
| `VEXA_ADMIN_API_URL` / `VEXA_ADMIN_API_KEY` | Vexa Admin API（容器內 127.0.0.1:8057，經 docker exec 呼叫） |

---

## 八、常見情境速查

| 我想要… | 要動的變數 |
|---------|-----------|
| 換 LLM 供應商（Gemini ↔ Claude） | 設定/註解 `GEMINI_API_KEY`，重啟 |
| 開插話功能來測 | `INTERJECTION_ENABLED=true`（建議搭配 `INTERJECTION_TURN_DETECTOR=livekit`） |
| 開破冰功能來測 | `ICEBREAKER_ENABLED=true` |
| 讓 Recall bot 開口說話 | 設 `OPENAI_API_KEY` |
| 讓喚醒詞「即時」有反應 | 設 `RECALL_WEBHOOK_URL` + `RECALL_WEBHOOK_TOKEN`（本機要 ngrok，見第三節） |
| 跑 Prisma CLI（migrate / db execute） | 確認 `DIRECT_URL`（5432）存在，CLI 自動走它 |
| 真的把邀請信寄出去 | 填 SMTP 六個變數（見 `.env.example` 註解） |

## 九、除錯對照

| 症狀 | 先查 |
|------|------|
| 後端啟動直接 exit + `Invalid environment variables` | 訊息會列出缺哪些必填變數 |
| Dify 回 401 | dataset key（`dataset-`）與 app key（`app-`）用反了 |
| 每題都回「沒有檢索到相關資訊」 | **Dify 平台端**環境變數沒設 dataset key（靜默失效，backend log 有 no-result sentinel 警告） |
| Prisma CLI 報 P1017（connection closed） | CLI 走到 6543 了；確認 `DIRECT_URL` 存在且是 5432 |
| 蜜塔不說話只回聊天室 | `OPENAI_API_KEY` 沒設（Recall TTS） |
| 喚醒詞完全沒反應 | `RECALL_WEBHOOK_URL` 沒設或 ngrok 斷了 |
