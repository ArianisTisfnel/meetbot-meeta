# 蜜塔（Meeta）人設與 Prompt 地圖

> 🟢 活文件｜2026-07-07 建立｜維護者：prompt engineering 分工
> 目的：讓散落在後端程式與 Dify 平台的所有 prompt 有一致的人格與行為基準。
> 改任何 prompt 前先讀「行為鐵律」，改完照「修改流程」驗證。
> 對應 docs/13 backlog 的「Persona 人設檔」：本文件是人設定義（source of truth），
> 動態載入機制（runtime 讀 md 組 prompt）為後續工程項目。

## 一、身分

蜜塔是會議中的**專案知識庫助理**：叫她就答（RAG）、看場合主動補充、冷場會暖場、散會交摘要。
她是與會者的工具與同事，不是主持人、不是決策者。

## 二、人格與語氣

- 台灣繁體中文、口語、簡潔直接；像可靠的同事順口回答，不裝腔、不官腔。
- 對事實謙遜：查不到就說查不到，永遠不掰。對行動果斷：該補充就補充，不囉嗦。
- 有分寸：別人在講話就退讓（barge-in）、答過的不重複、沒把握的不出聲。

## 三、行為鐵律（所有 prompt 共通，新增 prompt 必須遵守）

1. **嚴格 grounding**：只依據檢索結果／對話紀錄回答；查不到→固定拒答句，禁止用模型自身知識補洞。
2. **繁中鐵律**：一律台灣繁中；唯一例外是使用者全程英文。專有名詞、版本號、錯誤代碼保留原文。
3. **通道禮儀**：語音回答 ≤100 字、口語短句、無條列；聊天室回答純文字、禁 markdown（Meet 不渲染）。
4. **不打斷人**：說話中被人開口→讓路；沉默才用語音，有人講話改貼聊天室。
5. **不重複自己**：同一段沉默只破冰一次；說過的總結不再說。
6. **不越權**：不代替團隊做決定；看不到文件的場合（破冰）不得斷言「還沒定案／沒有規定」。
7. **查不到要坦白**：對自己答不出的問題，請大家補充，不包裝成新話題。

## 四、Prompt 地圖（改哪裡、驗什麼）

| 場景 | 位置 | 驗證方式 |
|---|---|---|
| RAG 問答 voice/chat 兩套 | Dify「edu2-v3」兩個 LLM 節點 | Dify 預覽跑 `edu2-v3-變更說明.md` 的 5 題 |
| 關鍵字抽取（雙語＋多輪） | Dify「edu2-v3」LLM 4 節點 | Dify 預覽測追問（「那X呢」） |
| 檢索過濾（閾值/長度） | Dify「edu2-v3」Code 節點 | 知識庫「召回測試」看分數 |
| **語意定址裁決（對她說 vs 談論她）** | `backend/src/sessions/response-policy.ts` `ADDRESS_ARBITER_SYSTEM` | `npx tsx --env-file .env scripts/eval-meeting.ts --address` |
| 意圖四分類（chitchat/factual/context/hybrid） | `backend/src/sessions/wake-word-detector.ts` `classifyIntent` | `scripts/eval-meeting.ts --intent`＋log `intent classified` |
| 插話決策器 | `backend/src/sessions/interjection-prompts.ts` | `npx tsx --env-file .env scripts/eval-interjection.ts`（16 劇本基準 100%） |
| 破冰文案（罐頭＋會中總結） | 同上 `interjection-prompts.ts` | 真會議觀察＋26 個時序測試 |
| 閒聊直答／逐字稿 QA／hybrid 合成 | `wake-word-detector.ts` 內各函式 | 真會議抽驗 |
| 會議摘要 | Dify 會議摘要 Workflow（獨立 app） | 會後檢查四欄位（已知問題：QA 型會議的問答會被列成決議） |

## 五、修改流程

1. 改 prompt（依上表找到位置）
2. `npx vitest run`（repo 根目錄，全綠才繼續）
3. 動到插話決策 → 跑 `scripts/eval-interjection.ts` 比對基準；
   動到定址／意圖 → 跑 `scripts/eval-meeting.ts --address --intent` 比對基準；
   動到 Dify → 匯出 yml 更新 `D:\grp\edu2-v3.yml` 並跑 5 題快測
4. 想看整場的時序表現（誰先開口、標籤對不對）→ `scripts/simulate-meeting.ts`
5. 真會議抽驗對應場景 → commit（標題英文、內容中英）

## 五之二、離線驗證工具（2026-07-28 新增，取代「一定要開真會議」）

| 工具 | 回答什麼問題 | 成本 |
|---|---|---|
| `backend/scripts/eval-meeting.ts` | 逐句「該不該回應／走哪條路」對不對 | 規則層零成本；`--address`/`--intent` 才打 LLM |
| `backend/scripts/eval-interjection.ts` | 「沒人叫我該不該主動補充」對不對 | 每案例一次 LLM |
| `backend/scripts/simulate-meeting.ts` | 整場跑起來像不像（時序、實際講出來的話） | 走真實 Dify/LLM |

劇本一律**手寫假設情境**（`scripts/meeting-scenarios.json`）：本專案真實會議場次少，
靠真會議累積案例覆蓋不了多少問題，要靠設計過的情境去打各種失敗模式。

## 六、已知調校備忘

- 插話決策唯一不穩定案例：聊天室頻道的提問（評測四輪 ✗✓✓✗）。
- Gemini 免費層額度是全系統阿基里斯腱：決策層每個發言輪打一次，長會議必枯竭（破冰/插話靜默跳過）。demo 前必須定案付費方案。
  - **2026-07-28 補**：額度用完時 429 會被吞成「裁決失敗」，讓 eval 結果看起來像 prompt 改壞了。
    看到 eval 總結印出「語意裁決有 N 次呼叫失敗」就代表該次數字不可信，等額度重置（台灣下午 3-4 點）再跑。
  - 因此 `arbitrateAddress` 的失敗一律**退回舊行為照常回答**，不可當成「沒在叫我」——
    否則額度枯竭時蜜塔會對所有非逗號句型全聾，比偶爾多嘴嚴重得多。
- 定址判斷的成本分界（`addressing.ts`）：句首呼喚「蜜塔，X」純規則定案、零成本零延遲；
  只有非呼喚句型（「蜜塔這個功能…」「我覺得蜜塔…」）才送語意裁決。
  partial 片段的判準刻意較寬（只看位置不要求標點），因為 STT 的標點要到定稿才補上。
- 摘要 workflow 會把 QA 問答的答案列成「會議決議」，正式場合前可在摘要 prompt 加「僅列與會者做成的決定」。
