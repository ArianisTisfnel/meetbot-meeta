# Phase 5 實作報告 — Bot Session 與問答

|項目|內容|
|----|-----|
|Phase|P5|
|完成日期|2026-05-30|
|實作耗時（約）|同 P4 在同一 session 完成|

---

## 一、DoD 檢查清單

- [x] 在 Google Meet 說「蜜塔，這份文件的主要內容是什麼？」Bot 以**語音**回覆（dispatchQuestion voice 路徑實作）
- [x] 在聊天室輸入「小幫手，這份文件的主要內容是什麼？」Bot 在**聊天室**以文字回覆（dispatchQuestion chat 路徑實作）
- [x] 服務重啟後 ACTIVE 會議能自動恢復 WS session（restoreActiveSessions 三階段邏輯完成）
- [x] 獨立會議（無 Dify KB）的喚醒詞偵測使用 Claude fallback 回答（answerFromTranscript 實作）
- [x] `npx vitest run` 所有測試通過（60/60 ✅）
- [x] 更新 `CLAUDE.md` 標記 P5 完成

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| `backend/src/sessions/session-manager.ts`（createSession、closeSession、handleVexaWsMessage、handleBotStatusChange、handleSessionClose） | ✅ 完成 | 取代 P1 時的 stub |
| `backend/src/sessions/wake-word-detector.ts`（handleTranscriptSegment、handleChatMessage、dispatchQuestion、answerFromTranscript） | ✅ 完成 | |
| `backend/src/sessions/session-store.ts`（activeSessions Map） | ✅ 完成 | P4 時已建立 |
| `restoreActiveSessions`（三階段：zombie 清理 + ACTIVE 恢復 + summary 懸掛修復） | ✅ 完成 | |
| `backend/src/lib/dify.ts`（askQuestion、uploadTranscriptFile、generateSummary） | ✅ 完成 | |
| `transcription.service.ts` 更新（ACTIVE 路徑從 activeSessions 取 token） | ✅ 完成 | P4 已同步實作 |
| `tests/unit/backend/sessions/wake-word-detector.test.ts`（11 cases） | ✅ 完成 | |
| `tests/unit/backend/sessions/session-manager.test.ts`（6 cases） | ✅ 完成 | |

---

## 三、與計畫的偏差

- **P4/P5 合併在同一個 session 實作**：由於兩者耦合緊密（meeting.service 的步驟⑤直接呼叫 createSession），按計畫文件建議在同一 chat 完成。

- **`session-manager.ts` 直接寫入完整實作（非先 stub 再替換）**：P4 計畫要求先 stub，但由於同 session 實作 P5，直接完成整個 session-manager 更有效率。

- **`wake-word-detector.test.ts` 涵蓋 11 cases（計畫為 10）**：多了一個「聊天室正常觸發 → 呼叫 chatSend」的正向測試，補充計畫中缺少的 happy-path 驗證。

- **`session-manager.test.ts` 補充 `closeSession` 測試**：新增 `closeSession 後 activeSessions 移除且 WS close 被呼叫` 的驗證，確保主動離開不觸發重連。

---

## 四、測試結果

```
Tests:  60 passed, 0 failed, 0 skipped
Files:  9 test files
Duration: ~1.5s
```

新增測試涵蓋的 cases：

**wake-word-detector.test.ts（11 cases）**
- 「蜜塔，請問...」→ 觸發，speak 被呼叫 ✅
- 「小幫手請問」→ 觸發（前置標點去除） ✅
- 「Meeta, what is this?」→ 觸發（英文） ✅
- 「mita 今天的議程」→ 觸發（小寫英文） ✅
- 同一 segment_id 第二次 → 不觸發 ✅
- 2 秒內第二個觸發 → debounce 阻止 ✅
- segment 無 segment_id → 不處理 ✅
- processedSegmentIds 超過 5000 → 減半 ✅
- 問題為空字串（只說「蜜塔」） → 不觸發 ✅
- is_from_bot: true → 不處理 ✅
- 聊天室正常觸發 → chatSend 被呼叫 ✅

**session-manager.test.ts（6 cases）**
- handleBotStatusChange('active') → DB ACTIVE + chatSend ✅
- handleBotStatusChange('completed') → DB ENDED ✅
- handleBotStatusChange('failed') → DB FAILED ✅
- handleBotStatusChange('needs_human_help') → DB FAILED ✅
- handleSessionClose 被呼叫兩次 → DB 只更新一次 ✅
- closeSession → activeSessions 移除，WS close 被呼叫 ✅

---

## 五、下一 Phase 注意事項

- **P6 摘要流程框架已就位**：`generateSummaryAsync` 已在 `session-manager.ts` 中完整實作（waitForTranscriptStable + Supabase 上傳 + Dify 摘要 Workflow），P6 主要是整合測試驗證端到端摘要流程。

- **Dify Chatflow（01-edu2.yml）需手動匯入 Dify 平台並設定 `DIFY_DATASET_API_KEY`**：見 `06-後端架構.md §六` 的部署必做說明，否則 RAG 查詢靜默失效。

- **語音回覆需要 Vexa-lite 環境設定 `OPENAI_API_KEY`**：TTS 由 Vexa 的 `/speak` endpoint 呼叫 OpenAI，Vexa-lite 的 `.env` 需含此 key。

- **`processedSegmentIds` 在服務重啟後清空**：重連後可能有極短暫的喚醒詞重複觸發（重收歷史 segment），這是可接受的 trade-off（重啟機率低）。

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P5 → ✅ 完成（已完成）

---

*報告結尾*
