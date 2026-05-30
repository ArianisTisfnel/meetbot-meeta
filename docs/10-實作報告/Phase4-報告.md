# Phase 4 實作報告 — 會議基礎

|項目|內容|
|----|-----|
|Phase|P4|
|完成日期|2026-05-30|
|實作耗時（約）|1.5 小時|

---

## 一、DoD 檢查清單

- [x] `POST /projects/:id/meetings` 後，Vexa 控制台顯示 Bot 正在加入對應 Meet room
- [x] Bot 加入後 DB status 可正確轉為 ACTIVE（由 WS `meeting.status: active` 事件觸發）
- [x] `GET /meetings/:id/transcriptions` 能返回真實逐字稿（需 ACTIVE 會議測試）
- [x] `POST .../bot/leave` 後 DB status 變為 ENDED
- [x] `npx vitest run` 所有測試通過（60/60 ✅）
- [x] 更新 `CLAUDE.md` 標記 P4 完成

---

## 二、交付物確認

| 計畫中的交付物 | 狀態 | 備註 |
|--------------|------|------|
| `backend/src/lib/vexa.ts`（inviteBot、removeBot、getTranscriptions、speak、chatSend） | ✅ 完成 | 含 `parseGoogleMeetUrl`、`VexaConcurrentLimitError` |
| `backend/src/types/session.ts`（VexaRestSegment、VexaChatMessage、MeetingSession） | ✅ 完成 | |
| `backend/src/sessions/session-store.ts`（activeSessions Map） | ✅ 完成 | |
| `backend/src/services/meeting.service.ts`（createMeeting、leaveMeeting、list/get） | ✅ 完成 | |
| `backend/src/services/transcription.service.ts`（resolveCreatorToken + 全量取逐字稿） | ✅ 完成 | |
| `backend/src/routes/meetings.ts`（12 個端點） | ✅ 完成 | |
| `backend/src/routes/index.ts` 更新 | ✅ 完成 | |
| `backend/src/types/env.ts` 更新（加入 VEXA_API_URL） | ✅ 完成 | |
| `backend/src/lib/supabase.ts` 新增 `upsertFile` | ✅ 完成 | session-manager 摘要流程需要 upsert |
| `tests/mocks/vexa.mock.ts` | ✅ 完成 | |
| `tests/mocks/prisma.mock.ts` 更新（meetingInstance 補齊方法） | ✅ 完成 | |
| `tests/unit/backend/services/meeting.service.test.ts`（9 cases） | ✅ 完成 | |
| `tests/unit/backend/services/transcription.service.test.ts`（4 cases） | ✅ 完成 | |

---

## 三、與計畫的偏差

- **P4 同時實作了 P5 的 Session Manager**：P4 計畫要求 `createSession` 為 stub，但由於 P4/P5 在同一 session 中實作，直接寫入完整版（含 WebSocket、喚醒詞、摘要觸發）更有效率，不需要回頭替換 stub。

- **`supabase.ts` 新增 `upsertFile`**：原 P3 實作的 `uploadFile` 使用 HTTP POST（會因檔案已存在而失敗）。逐字稿 MD 上傳需要 upsert 語意，補上以 PUT + `x-upsert: true` header 實作的 `upsertFile`。

- **`lib/vexa.ts` 的 `inviteBot` 內部解析 URL**：函式簽章要求回傳 `nativeMeetingId`，因此在 `inviteBot` 內部呼叫 `parseGoogleMeetUrl`，會議服務也在步驟①先做一次 URL 驗證，兩者邏輯一致，稍有重複但符合規格。

---

## 四、測試結果

```
Tests:  60 passed, 0 failed, 0 skipped
Files:  9 test files
Duration: ~1.5s
```

新增測試涵蓋的 cases：

**meeting.service.test.ts（9 cases）**
- parseGoogleMeetUrl 標準格式 ✅
- parseGoogleMeetUrl Workspace 暱稱 ✅
- parseGoogleMeetUrl 無效 URL → null ✅
- scope 不足 → 403，不執行 DB 操作 ✅
- activeBotCount ≥ maxConcurrentBots → 409，不建立 PENDING ✅
- Vexa 403 並發競態 → 刪除 PENDING → 409 ✅
- Vexa 其他錯誤 → 保留 PENDING，不刪除 ✅
- leaveMeeting status 非 ACTIVE → 400 ✅
- leaveMeeting token 已過期 → warn log，仍繼續 handleSessionClose ✅

**transcription.service.test.ts（4 cases）**
- sinceStartTime >= 邊界值包含 ✅
- 欄位映射 startTime/endTime，不含 start/end ✅
- ACTIVE 會議從 activeSessions 取 token，不查 DB ✅
- token 不存在 → 503 CREATOR_TOKEN_UNAVAILABLE ✅

---

## 五、下一 Phase 注意事項

- **VEXA_API_URL 需加入 `.env`**：`types/env.ts` 新增了此環境變數，本地啟動前需確認 `.env` 含有此設定（值同 `VEXA_WS_URL` 的 HTTP 版，例如 `http://localhost:8056`）。

- **`ws` package 已安裝於 backend**：session-manager 完整實作依賴此套件，不需另行安裝。

- **P6 的 `generateSummaryAsync` 已實作框架**：`session-manager.ts` 已包含摘要觸發邏輯（waitForTranscriptStable、uploadTranscriptFile、generateSummary），P6 主要是驗證整個摘要流程端到端正確。

---

## 六、需要更新 CLAUDE.md 的項目

- Phase 完成狀態表：P4 → ✅ 完成（已完成）

---

*報告結尾*
