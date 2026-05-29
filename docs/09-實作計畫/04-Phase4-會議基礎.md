# Phase 4 — 會議基礎

|項目|內容|
|----|-----|
|Phase|P4|
|前置條件|P3 完成|
|參考文件|`04-API設計.md` §八~九、`06-後端架構.md` §三~四、`03-資料庫Schema設計.md` §4.4|

---

## 一、交付物

1. **Vexa client**（`src/lib/vexa.ts`）：POST /bots、DELETE /bots、GET /transcripts
2. **Meeting Service**：建立會議（含 Bot 邀請流程）、列表/取得、Bot leave（不含摘要，P6 補）
3. **Transcription Service**（`src/services/transcription.service.ts`）：逐字稿代理（resolveCreatorToken + Vexa REST）
4. **路由**：`/meetings`（全局）、`/projects/:id/meetings`（含 transcriptions、bot/leave）

> **注意**：此 Phase Bot 邀請後 WS session 由 stub 處理（P5 填入真正的 session 管理邏輯）。
> P4 的目標是讓 `POST /meetings` 可呼叫 Vexa，DB 狀態能轉換，WS 部分留空 stub。

---

## 二、實作順序

### 2.1 Vexa Client（`src/lib/vexa.ts`）

```typescript
// POST /bots：邀請 Bot 加入 Google Meet
export async function inviteBot(params: {
  googleMeetUrl: string
  vexaToken: string
  botName?: string
  voiceAgentEnabled?: boolean
}): Promise<{ vexaMeetingId: number; nativeMeetingId: string }>

// DELETE /bots/{platform}/{nativeMeetingId}：讓 Bot 離開
export async function removeBot(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string
): Promise<void>

// GET /transcripts/{platform}/{nativeMeetingId}：取全量逐字稿
export async function getTranscriptions(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string
): Promise<VexaRestSegment[]>

// POST /bots/{platform}/{nativeMeetingId}/speak：TTS 語音
export async function speak(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
  params: { text: string; provider: string; voice: string }
): Promise<void>

// POST /bots/{platform}/{nativeMeetingId}/chat：發送聊天室文字
export async function chatSend(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
  params: { text: string }
): Promise<void>
```

新增 mock：`tests/mocks/vexa.mock.ts`

### 2.2 Google Meet URL 解析（共用函式）

依 `04-API設計.md §九` 的正則：
```typescript
export function parseGoogleMeetUrl(url: string): string | null {
  const m = url.match(
    /meet\.google\.com\/((?:[a-z]{3}-[a-z]{4}-[a-z]{3})|(?:[a-z0-9][a-z0-9-]{3,38}[a-z0-9]))/
  )
  return m ? m[1] : null
}
```

### 2.3 Meeting Service（`src/services/meeting.service.ts`）

**`createMeeting(vexaUserId, params)`**（依 `04-API設計.md §九` 流程）：
```
① parseGoogleMeetUrl → 失敗 400
   requireBotScopes → 缺少 403 INSUFFICIENT_SCOPE
② 若有 projectId：驗證 canMeeting
   activeBotCount = ACTIVE meeting count；若 ≥ maxConcurrentBots → 409
③ Prisma create MeetingInstance (status: PENDING)
④ vexaClient.inviteBot(...)
   → Vexa 403（並發競態）→ 刪除③的 PENDING record → 409 BOT_CONCURRENT_LIMIT
   → 其他錯誤 → 保留 PENDING，return（UI 顯示重試）
⑤ 呼叫 createSession stub（P5 填實作）
   → 成功：更新 DB vexaMeetingId、vexaNativeMeetingId、creatorApiTokenId（維持 PENDING）
   → 失敗：呼叫 vexaClient.removeBot，保留 PENDING
```

**`leaveMeeting(meetingInstanceId, vexaUserId)`**（依 `04-API設計.md §九`）：
- 授權驗證（canMeeting）
- 只有 ACTIVE 時有效
- 呼叫 `handleSessionClose(meetingInstanceId)` stub（P5 填入摘要觸發；此 Phase 只更新 status: ENDED）

**`listMeetings(projectId?, vexaUserId, params)`**、**`getMeeting(meetingId, vexaUserId)`**：正常 CRUD 查詢

### 2.4 Transcription Service（`src/services/transcription.service.ts`）

依 `06-後端架構.md §五之一`：
- `resolveCreatorToken`：ACTIVE 從 session 取（此 Phase 暫時只查 DB），ENDED 查 DB
- 全量取逐字稿 + 記憶體 filter `since_start_time`（>= 語意）
- 欄位映射：`start`/`end` → `startTime`/`endTime`（camelCase 轉換必做）

---

## 三、本 Phase 的單元測試

### `tests/unit/backend/services/meeting.service.test.ts`

需覆蓋的 cases：
1. `parseGoogleMeetUrl` 標準格式（`abc-defg-hij`）→ 回傳 `abc-defg-hij`
2. `parseGoogleMeetUrl` Workspace 暱稱（`my-weekly-standup`）→ 正確解析
3. `parseGoogleMeetUrl` 無效 URL → null → 400
4. `createMeeting` scope 不足 → 403（不執行後續步驟）
5. `createMeeting` activeBotCount ≥ maxConcurrentBots → 409（不建立 PENDING record）
6. `createMeeting` Vexa 403 並發競態 → 刪除 PENDING record → 409
7. `createMeeting` Vexa 其他錯誤 → 保留 PENDING record（不刪除）
8. `leaveMeeting` status 非 ACTIVE → 400（不呼叫 vexaClient）
9. `leaveMeeting` token 已過期 → warn log，仍繼續更新 DB 為 ENDED

### 補充 `tests/unit/backend/services/transcription.service.test.ts`（小規模）

1. `since_start_time` filter 使用 `>=`（邊界 segment 包含在內）
2. 欄位映射：回傳物件含 `startTime`（camelCase），不含 `start`

---

## 四、Definition of Done

- [ ] `POST /projects/:id/meetings` 後，Vexa 控制台顯示 Bot 正在加入對應 Meet room
- [ ] Bot 加入後（Vexa 觸發 meeting.status: active，目前僅靠 stub 設定）DB status 可正確轉為 ACTIVE（P5 才真正由 WS 觸發）
- [ ] `GET /meetings/:id/transcriptions` 能返回真實逐字稿（需 ACTIVE 會議測試）
- [ ] `POST .../bot/leave` 後 DB status 變為 ENDED
- [ ] `npx vitest run` 所有測試通過
- [ ] 更新 `CLAUDE.md` 標記 P4 完成

---

*文件結尾*