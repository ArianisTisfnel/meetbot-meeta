🟢 活文件

# Recall Failover + 即時問答 — 開發者設定

> 這份只講 **Recall failover 與即時語音/聊天問答** 需要的額外設定。
> Vexa / Supabase / Dify / 前端的基本設定請看 [README.md](../README.md)。

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
