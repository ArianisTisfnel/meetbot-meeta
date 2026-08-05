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
| **每輪語意決策（定址／問題／意圖／插話，四合一）** | `backend/src/sessions/interjection-prompts.ts` `TURN_DECISION_SYSTEM`（邏輯在 `response-policy.ts` `decideTurn`） | **兩個都要跑**：`scripts/eval-meeting.ts --address`（定址、連續追問）＋`scripts/eval-interjection.ts --variant live`（插話，22 劇本，見第六節） |
| ↳ 意圖四分類（chitchat/factual/context/hybrid） | 同上 prompt 的 ③ 段 | `scripts/eval-meeting.ts --intent`＋log `intent classified` |
| 破冰文案（罐頭＋會中總結） | 同上 `interjection-prompts.ts` | 真會議觀察＋26 個時序測試 |
| 閒聊直答／逐字稿 QA／hybrid 合成 | `wake-word-detector.ts` 內各函式 | 真會議抽驗 |
| 會議摘要 | Dify 會議摘要 Workflow（獨立 app） | 拿 `D:\grp\摘要驗證用-純QA無決議逐字稿.txt` 跑，decisions／action_items 應為 `[]` |

## 五、修改流程

1. 改 prompt（依上表找到位置）
2. `npx vitest run`（repo 根目錄，全綠才繼續）
3. 動到 `TURN_DECISION_SYSTEM`（定址／意圖／插話現在同一份）→ **兩個評測都要跑**：
   `scripts/eval-meeting.ts --address` ＋ `scripts/eval-interjection.ts --variant live`，各自比對基準；
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

- **插話決策正式基準（2026-08-03 意見型放寬後，22 劇本 × 3 輪 = 66 案例）**：
  **準確率 97.0%（64/66）｜誤插話 1｜漏插話 1｜問題忠實度 0**。
  跑法：`scripts/eval-interjection.ts --variant live --runs 3 --delay-ms 12000`
  （模型 `gemini-flash-lite-latest`、temperature 0，與線上 `decideTurn` 逐項對齊）。
  改動 `TURN_DECISION_SYSTEM` 之後以此為對照，**判準：誤插話不得增加（≤1）**。
  - 前一版基準（16 劇本 × 3 = 48 案例，尚未放寬意見型）：95.8%（46/48）、誤插 1、漏插 1。
    **放寬後多涵蓋 6 個劇本、準確率反而上升，誤插話沒有增加**——收緊條件（只在
    「沒有人回應那個問題」時才插話）確實抵銷了放寬帶來的風險。
  - 兩個不穩定案例（各只錯一輪，temperature 0 下 Gemini 仍非完全決定性）：
    「不插話：有人已表示要去查」誤插一次；「應插話：意見型問全場」漏插一次。
  - 舊的「聊天室提問」老問題（四輪 ✗✓✓✗）**連兩次全跑都 3/3**：那些抖動有相當部分
    是量測工具自己製造的（見下一條），不是 prompt 不穩。
  - ⚠️ **局部回歸 ≠ 基準**：改 prompt 後可用 `--only A,B,C` 只重測受影響的劇本省額度，
    但**要寫進文件的基準數字一定要全跑**（局部只證明沒改壞，不能代表整體）。
- Gemini 免費層額度是全系統阿基里斯腱：決策層每個發言輪打一次，長會議必枯竭（破冰/插話靜默跳過）。demo 前必須定案付費方案。
  - **2026-07-28 補**：額度用完時 429 會被吞成「語意層失敗」，讓 eval 結果看起來像 prompt 改壞了。
    看到 eval 總結印出「語意層有 N 次呼叫失敗」就代表該次數字不可信，換一把 key 重跑（見下面第四點）。
  - 因此 `decideTurn` 失敗時，**句中提及**（有喊名字）一律退回舊行為照常回答，不可當成「沒在叫我」——
    否則額度枯竭時蜜塔會對所有非逗號句型全聾，比偶爾多嘴嚴重得多。
    **連續追問候選**（沒喊名字）相反，退回安靜（見下一條）。
  - ~~同一份 prompt 在兩個評測裡跑的模型不一樣~~ → **已修（2026-08-03）**。
    修的時候發現是**雙重**不一致：`eval-interjection.ts` 少了 `purpose:'interjection'`
    （→ 走 `GEMINI_MODEL` 而非線上的 `GEMINI_INTERJECTION_MODEL`），**也少了 `temperature: 0`**
    （→ 用預設 1.0，評測比線上更飄）。兩者都補上，降級路徑（`.env` 不完整時的內建直呼叫）
    同步對齊 `GEMINI_INTERJECTION_API_KEY/_MODEL`。
    教訓：評測與線上共用同一份 prompt 還不夠，**呼叫參數要逐項對齊**才算同一條路。
  - **429 不一定是「每日額度用完」，先別急著等到明天**（2026-07-29 誤判過一次）：
    當天連跑四輪把一把 key 打到整批 429，錯誤訊息寫的是 "You exceeded your current quota"，
    看起來像 RPD 用完；但**一個半小時後同一把 key 就恢復了**，其實是較短窗的節流。
    - 判斷方法：拿 `docs/env_API-key` 裡的每一把 key 各打一次 1 token 的請求看 HTTP 狀態，
      全部 200 就代表沒事，直接換一把繼續跑，不必空等。
    - 換模型救不了（`gemini-2.5-flash`／`gemini-flash-lite-latest`／`gemini-2.5-flash-lite`
      當天同時 429），**換 key 才有用**——`docs/env_API-key` 有六把，分屬不同 Google Cloud 專案。
    - 跑法：`GEMINI_API_KEY=<另一把> npx tsx --env-file .env scripts/eval-meeting.ts --address`
      （shell 環境變數優先於 `--env-file`，不必改 `.env`）
  - ⚠️ **兩個評測不可以同時跑**：共用同一把 key，併發會互相打成 429，兩邊數字一起作廢
    （2026-07-29 踩過，白燒一整輪額度）。兩輪之間也建議換不同的 key。
- **叫停指令走純規則、不進語意層**（2026-07-29）：`addressing.ts` 的 `STOP_COMMAND_REGEX`
  與 barge-in 共用同一份詞表（原本只有 barge-in 查，導致「蜜塔 不用了」被當成新問題送去檢索）。
  判定順序刻意排在 debounce 與 ambiguous **之前**：叫停幾乎必然落在 debounce 窗內，
  且不該為了「這是不是在跟我說話」再花一次 LLM。
  整句錨定（`^...$`）：「不用了，我們改用別的方案」是討論內容，不可靜音。
  措辭鬆散的叫停（「你先不用查了」）留給語意層。
- **講者歸屬（A.4）走時間軸反查，不靠轉錄本身**（2026-07-29）：AGENT_MODE 單軌混音轉錄
  沒有講者標記，改由 Recall 的 `participant_events.speech_on/off` 建時間軸
  （`backend/src/agent/speaker-timeline.ts`），轉錄定稿時反查。兩個反直覺的實作決定寫在該檔開頭：
  用 epoch ms 而非 Recall 的 `timestamp.relative`（座標原點不同）、
  查詢是「回看 15 秒窗取重疊最大者」而非點查詢（agent 的 `startTime` 其實是轉錄**完成**時刻）。
  同時發言時回 null 而非硬猜——標錯人比不標更傷。
- 定址判斷的成本分界（`addressing.ts`）：句首呼喚「蜜塔，X」與叫停純規則定案、零成本零延遲；
  只有兩種情形送語意層——非呼喚句型（「蜜塔這個功能…」）、以及**對話串還開著時沒喊名字的發言**。
  partial 片段的判準刻意較寬（只看位置不要求標點），因為 STT 的標點要到定稿才補上。
- **每輪一次呼叫，同時判定址／意圖／插話**（2026-07-29，回報 A.3 連續追問）：
  原本 `ADDRESS_ARBITER_SYSTEM`、`classifyIntent`、`INTERJECTION_DECISION_SYSTEM` 各看同一份
  rolling window 問高度重疊的問題，合併成 `TURN_DECISION_SYSTEM` 之後**額度不增反減**
  （句中提及原本要打兩次，現在一次）。連續追問因此不必再靠時間近似語意。
  - 兩個出口互斥：`addressed=address` → 當成喚醒問答回答（沒喊名字的追問走這條）；
    否則才看 `interject`。`eval-interjection` 的劇本全是「沒人叫蜜塔」，語意與基準不變。
  - ⚠️ **`question` 的取材範圍兩個出口不一樣，prompt 裡必須分開寫**（2026-07-29 踩過）：
    `addressed=address` → 只能取自**最後一則**（否則會把前一輪單獨喊的「蜜塔」當成問題去查資料）；
    插話 → 可以取自窗裡**任何一則**沒人回答的問題（被閒聊蓋過、或打在聊天室沒人理的才是該補的）。
    只寫「一定要取自最後一則」會讓插話整批回空 `question`，線上等於完全不補充。
    合併 prompt 時，共用欄位要逐一問「兩個出口對它的要求一樣嗎」。
  - **呼叫失敗的退回方向兩邊相反，不可統一**：有喊名字（句中提及）→ 照常回答；
    沒喊名字（追問候選）→ 安靜。後者若也退回照常回答，額度枯竭時蜜塔會把會議裡
    每一句話都當成在問她。
  - `WAKE_PENDING_MS` 8 秒待命窗已退役，換成 `FOLLOWUP_WINDOW_MS`（90 秒）。
    角色完全不同：舊的是**判準**（窗內就當問題，所以只接得住「叫名字→停頓→問題」）；
    新的只是**成本閘門**（擋掉蜜塔沒參與過的對話，免得整場每句都送去問），判準交給語意層。
  - ⚠️ 評測與線上的一處差異：`eval-meeting` 的對話窗**不含蜜塔的回答**（劇本只寫人講的話），
    線上的窗夾著她的回覆。評測看到的追問線索比線上少，這一側偏嚴不偏鬆。
- ~~摘要 workflow 會把 QA 問答的答案列成「會議決議」~~ → **已修（2026-08-03）**。
  摘要 workflow（獨立 app）的 system prompt 加兩段：
  (a) **誰是與會者、誰是助理**——逐字稿裡標「蜜塔（聊天室）／（語音）」的是 AI 助理，
      她的查詢回覆與主動提問**都不是與會者做成的決定或承諾的工作**；
  (b) **納入判準**——decisions 只列有人拍板／達成共識的事，三類明文排除（查詢結果、
      蜜塔的提問建議、還在討論中的選項）；action_items 只列與會者承諾或被指派的事，
      蜜塔拋的問題除非有人明確承接才算；找不到就回空陣列，**寧缺勿濫**。
      另加防矯枉過正的但書：summary/key_topics 仍可涵蓋蜜塔提供的資訊，
      但措辭要如實（「查詢得知報名費 500 元」而非「決議報名費 500 元」）。
  - **驗證（純 QA 無決議逐字稿，`D:\grp\摘要驗證用-純QA無決議逐字稿.txt`）**：
    舊版 decisions 列出 6 條查詢結果當決議、action_items 把蜜塔自己拋的問題列成待辦；
    新版兩者皆 `[]`，且 summary 主動寫明「會中未做出新的決議或指派待辦事項」。
  - ⚠️ **測試素材要有分辨力**（這次的方法論教訓）：第一份驗證素材裡有一個明顯的真人拍板，
    模型有錨點就不會亂抓，**兩版都通過、等於沒測**。要打的是「全場沒有任何真人決議」的
    純 QA 會議——那才是模型會拿查詢結果填欄位的情境。
    同一類錯誤也發生在評測工具身上（測錯模型），**量測方法本身要先被驗證**。

- ⚠️ **`npx vitest run` 一定要在 repo 根目錄跑**：`backend/` 底下有自己的 `vitest.config.ts`
  （只給後端測試用，沒有前端的 `@`、`next-auth` 別名），在那裡跑會讓 3 個前端測試檔
  假性失敗（`Failed to load url @/lib/api-client`）。剛跑完 `scripts/eval-*.ts` 還停在
  `backend/` 時最容易踩到。
