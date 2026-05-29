# Phase 5 — Bot Session 與問答

|項目|內容|
|----|-----|
|Phase|P5|
|前置條件|P4 完成（Meeting service、Vexa client）|
|參考文件|`06-後端架構.md` §五（session-store、session-manager、wake-word-detector）、`02-使用者需求.md` §五|

> **聊天室建議**：P4 和 P5 耦合緊密（createSession 在 meeting.service 的步驟⑤觸發），  
> 建議與 P4 使用**同一個聊天室**，在 P4 stub 確認能運作後直接填入 P5 實作。

---

## 一、交付物

1. **Session Store**（`src/sessions/session-store.ts`）：`activeSessions` Map
2. **Session Manager**（`src/sessions/session-manager.ts`）：`createSession`、`closeSession`、`handleVexaWsMessage`、`handleBotStatusChange`、`handleSessionClose`
3. **Wake Word Detector**（`src/sessions/wake-word-detector.ts`）：`handleTranscriptSegment`、`handleChatMessage`、`dispatchQuestion`
4. **Dify Q&A client 函式**（`src/lib/dify.ts`）：`askQuestion`
5. **Claude fallback**（`answerFromTranscript`）
6. **Session 恢復**（`restoreActiveSessions`，服務重啟時呼叫）

---

## 二、實作順序

### 2.1 Session Types（`src/types/session.ts`）

完整實作 `MeetingSession` interface 和 `VexaRestSegment`、`VexaChatMessage` 型別（詳見 `06-後端架構.md §5.1.1`）。

### 2.2 Session Manager

完整實作 `06-後端架構.md §5.2` 的所有函式：

- **`createSession`**：建立 per-session WebSocket（使用邀請者 token），訂閱三條 channel，掛載 message handler，設置 WS close 重連邏輯
- **`closeSession`**：先從 Map 刪除（防重連），再 unsubscribe + close WS
- **`handleVexaWsMessage`**：依 `msg.type` 路由到 `handleTranscriptSegment`、`handleBotStatusChange`、`handleChatMessage`
- **`handleBotStatusChange`**：
  - `active` → 更新 DB ACTIVE + startedAt，發送歡迎訊息（非同步，catch error）
  - terminal（completed/failed/needs_human_help）→ 呼叫 `handleSessionClose`
- **`handleSessionClose`**：Map 原子鎖移除 → 更新 DB ENDED/FAILED → 觸發摘要（P6 stub）→ WS cleanup
- **`restoreActiveSessions`**：查 DB `status = ACTIVE`，重建 WS session（服務重啟恢復）

**關鍵**：P4 的 `createMeeting` 步驟⑤ 替換 stub 為真正的 `createSession` 呼叫。

### 2.3 Wake Word Detector

完整實作 `06-後端架構.md §5.3`：

- `WAKE_WORD_REGEX = /[蜜密祕秘迷][塔搭]|小幫手|[Mm]eeta|[Mm]ita/`
- `processedSegmentIds` 去重（含 size 上限 5000 + 減半策略）
- `DEBOUNCE_MS = 2000`（跨語音/聊天共用 `lastWakeAt`）
- 提問擷取：`slice(match.index + match[0].length).replace(/^[\s，。！？、…]+/, '')`
- `dispatchQuestion(session, question, 'voice' | 'chat')`

### 2.4 Dify Q&A Client（`src/lib/dify.ts`）

實作 `askQuestion` 函式（見 `06-後端架構.md §六`）：
- `POST /chat-messages`，帶 `inputs.dataset_id`、`inputs.mode`、`conversation_id`
- 超時：`AbortSignal.timeout(DIFY_CHATFLOW_TIMEOUT_MS ?? 45_000)`
- 靜默失效偵測：比對 `'抱歉 沒有檢索到相關資訊'` sentinel

### 2.5 Claude Fallback（`answerFromTranscript`）

在 `wake-word-detector.ts` 中實作（見 `06-後端架構.md §5.3`）：
- 取最近 30 段逐字稿作 context
- `claude-sonnet-4-6`，max_tokens: 512
- 若無逐字稿 → 回傳固定提示文字

### 2.6 Transcription Service 更新

`resolveCreatorToken` 的 ACTIVE 路徑改為從 `activeSessions.get(...)?.creatorVexaToken`（記憶體直取）。

---

## 三、本 Phase 的單元測試

### `tests/unit/backend/sessions/wake-word-detector.test.ts`

需覆蓋的 cases：
1. `蜜塔，請問這份規則是最新版嗎？` → 觸發，question = `請問這份規則是最新版嗎？`
2. `小幫手請問` → 觸發，question = `請問`（前置標點去除）
3. `Meeta, what is this?` → 觸發（英文）
4. `mita 今天的議程` → 觸發（小寫英文）
5. 同一 segment_id 第二次 → 不觸發（processedSegmentIds 已有）
6. 2 秒內第二個觸發 → 被 debounce 阻止
7. segment 無 segment_id → 不處理（skip）
8. `processedSegmentIds` 超過 5000 → 減半（size 約 2500）
9. 問題為空字串（只說了「蜜塔」）→ 不觸發 dispatchQuestion
10. 聊天室輸入 `is_from_bot: true` → 不處理

### `tests/unit/backend/sessions/session-manager.test.ts`

需覆蓋的 cases：
1. `handleBotStatusChange('active')` → Prisma update ACTIVE + startedAt，呼叫 chatSend 歡迎訊息
2. `handleBotStatusChange('completed')` → 呼叫 handleSessionClose（DB ENDED）
3. `handleBotStatusChange('failed')` → DB FAILED，不觸發摘要
4. `handleBotStatusChange('needs_human_help')` → DB FAILED（與 failed 相同處理）
5. `handleSessionClose` 被呼叫兩次（雙重清理競態）→ 第二次因 Map 已空而 early return
6. `closeSession` 後 WS close 不觸發重連

---

## 四、Definition of Done

- [ ] 在 Google Meet 說「蜜塔，這份文件的主要內容是什麼？」Bot 以**語音**回覆
- [ ] 在聊天室輸入「小幫手，這份文件的主要內容是什麼？」Bot 在**聊天室**以文字回覆
- [ ] 服務重啟後 ACTIVE 會議能自動恢復 WS session（逐字稿不中斷）
- [ ] 獨立會議（無 Dify KB）的喚醒詞偵測使用 Claude fallback 回答
- [ ] `npx vitest run` 所有測試通過
- [ ] 更新 `CLAUDE.md` 標記 P5 完成

---

*文件結尾*