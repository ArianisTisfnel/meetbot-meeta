# Phase 6 — 會議摘要

|項目|內容|
|----|-----|
|Phase|P6|
|前置條件|P5 完成（handleSessionClose 已實作，目前 stub 不觸發摘要）|
|參考文件|`06-後端架構.md` §5.2（generateSummaryAsync、waitForTranscriptStable、formatTranscriptAsMarkdown）、`04-API設計.md` §十一 10.3|

---

## 一、交付物

1. **Summary 流程**：`generateSummaryAsync`（逐字稿穩定等待 → MD 格式化 → Storage 儲存 → Dify 摘要 Workflow）
2. **Dify client 擴充**：`uploadTranscriptFile`、`generateSummary`
3. **`handleSessionClose`** 更新：填入真正的摘要觸發（替換 P5 的 stub）

---

## 二、實作順序

### 2.1 Dify 摘要相關函式（`src/lib/dify.ts`）

**`uploadTranscriptFile(meetingInstanceId, markdownContent)`**
- POST /files/upload（multipart/form-data）
- 使用 `DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY`
- 回傳 `upload_file_id`（string）

**`generateSummary(params)`**
- POST /workflows/run
- `inputs.transcript`：`{ transfer_method: "local_file", upload_file_id, type: "document" }`
- 輸出：解析 `data.outputs.result_json`（json.parse）
  - `summary: string`
  - `action_items: Array<{task: string, owner: string}>`
  - `key_topics: string[]`
  - `decisions: string[]`

### 2.2 逐字稿格式化（`formatTranscriptAsMarkdown`）

```typescript
function formatTranscriptAsMarkdown(segments: VexaRestSegment[]): string {
  // 使用 seg.start（REST alias），非 seg.start_time
  // 格式：**[HH:MM:SS] Speaker**: text（逐段換行）
}

function formatSeconds(seconds: number): string {
  // h > 0 → H:MM:SS；否則 M:SS
}
```

### 2.3 逐字稿穩定等待（`waitForTranscriptStable`）

依 `06-後端架構.md §5.2`：
- `SUMMARY_INITIAL_WAIT_MS = 5_000`（初始等待）
- `SUMMARY_POLL_INTERVAL_MS = 3_000`（輪詢間隔）
- `SUMMARY_STABLE_POLLS = 2`（連續 N 次相同即穩定）
- `SUMMARY_TIMEOUT_MS = 30_000`（硬超時）

### 2.4 `generateSummaryAsync`

完整實作 `06-後端架構.md §5.2` 的 `generateSummaryAsync` 函式：

```
1. waitForTranscriptStable → segments
2. 若 segments 為空 → set summary = ''（停止前端輪詢），return
3. formatTranscriptAsMarkdown → transcriptMd
4. Supabase Storage upload（transcripts/{meetingInstanceId}/transcript.md）
5. dify.uploadTranscriptFile → difyFileId
6. dify.generateSummary → { summary, actionItems, keyTopics, decisions }
7. Prisma update MeetingInstance
catch → set summary = ''（同樣停止輪詢，避免前端無限輪詢）
```

### 2.5 `handleSessionClose` 更新

在 P5 的 `handleSessionClose` 中，將摘要 stub 替換為真正呼叫 `generateSummaryAsync`（fire-and-forget，不 await）：

```typescript
if (meetbotFinalStatus === 'ENDED') {
  generateSummaryAsync({ meetingInstanceId, platform, nativeMeetingId, creatorVexaToken, difyDatasetId })
}
```

---

## 三、本 Phase 的單元測試

### `tests/unit/backend/sessions/summary.service.test.ts`

需覆蓋的 cases：
1. `formatTranscriptAsMarkdown` 正常格式化（含 speaker、時間戳、無說話者 fallback 為「參與者」）
2. `formatSeconds`：< 1 小時 → `M:SS`；≥ 1 小時 → `H:MM:SS`
3. `generateSummaryAsync` 正常流程：Storage 上傳、Dify file upload、Dify workflow 均被呼叫
4. `generateSummaryAsync` 逐字稿為空 → 不呼叫 Dify，`summary` 更新為 `''`（空字串 sentinel）
5. `generateSummaryAsync` Dify workflow 拋錯 → catch 後 `summary` 更新為 `''`
6. Storage 上傳失敗 → warn log，繼續執行摘要（不中斷）
7. `waitForTranscriptStable` 穩定偵測：連續 2 次 count 相同則回傳（mock vexaClient.getTranscriptions 回傳固定陣列）
8. `waitForTranscriptStable` 超時（30 秒）→ 回傳目前最後取得的 segments

---

## 四、Definition of Done

- [ ] Bot 離會後 5~30 秒內，`GET .../meetings/:id` 的 `summary` 欄位填入內容
- [ ] `actionItems` 陣列包含 `{task, owner}` 結構
- [ ] Supabase Storage 出現 `transcripts/{id}/transcript.md` 檔案
- [ ] 無逐字稿時，`summary = ''`（前端停止輪詢，顯示「無摘要」）
- [ ] Dify 摘要 Workflow 失敗時，`summary = ''`（前端不無限輪詢）
- [ ] `npx vitest run` 所有測試通過
- [ ] 更新 `CLAUDE.md` 標記 P6 完成

---

*文件結尾*