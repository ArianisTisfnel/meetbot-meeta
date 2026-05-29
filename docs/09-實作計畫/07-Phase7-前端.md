# Phase 7 — 前端

|項目|內容|
|----|-----|
|Phase|P7|
|前置條件|P4+ 完成（後端 API 可用）；可與 P5/P6 並行開展|
|參考文件|`05-前端架構.md` 全文、`04-API設計.md`（API 合約）|

---

## 一、交付物

1. **Next.js 15 App Router 專案**（`frontend/`）
2. **認證**：NextAuth + Vexa token session callback
3. **API Client**（`src/lib/api-client.ts`）
4. **全部頁面**：Projects、Materials、Meetings（全局 + 專案內）、Members、History
5. **全部自訂 Hook**：useProjects、useMaterials、useMeetings、useLiveTranscriptions 等
6. **前端測試**：hook 邏輯、關鍵 component

---

## 二、實作順序

### 2.1 Next.js 專案初始化

```bash
cd frontend
npx create-next-app@latest . --typescript --tailwind --app --no-src-dir
npx shadcn-ui@latest init
npx shadcn-ui@latest add button card dialog form input badge toast
npm install @tanstack/react-query react-hook-form zod react-dropzone sonner
npm install next-auth lucide-react
```

測試框架：
```bash
npm install -D vitest @testing-library/react @testing-library/user-event jsdom
```

### 2.2 NextAuth 設定（`app/api/auth/[...nextauth]/route.ts`）

沿用 Vexa dashboard 的 NextAuth config。關鍵點：

```typescript
// lib/auth.ts
callbacks: {
  session: async ({ session, token }) => {
    session.vexaToken = token.vexaToken  // 注入 Vexa API token
    return session
  }
}
```

### 2.3 API Client（`lib/api-client.ts`）

完整實作 `05-前端架構.md §五`（get / post / postForm / patch / delete）。

### 2.4 Types（`types/api.ts`）

從 `04-API設計.md` 的所有 Response 定義提取 TypeScript 型別，包含：
`ProjectListItem`、`ProjectDetail`、`UserPermissions`、`Material`、`MeetingInstance`、`TranscriptSegment` 等。

### 2.5 自訂 Hook（`hooks/`）

按 `05-前端架構.md §四` 逐一實作，**重點細節**：

- `useMeeting`：輪詢停止條件中，`summary === null` 才繼續（不可用 `!summary`，空字串 `''` 應停止）
- `useLiveTranscriptions`：Map upsert 去重，cursor 為 `seg.startTime`（float），優先用 `segmentId` key

### 2.6 Pages 實作順序

建議按以下優先序（高依賴先建）：

1. `(auth)/login/page.tsx` — 登入頁（沿用 Vexa）
2. `(app)/layout.tsx` — App Shell（認證守衛 + Sidebar）
3. `(app)/projects/page.tsx` — Projects 總覽
4. `(app)/projects/[projectId]/layout.tsx` — 專案 Shell
5. `(app)/projects/[projectId]/materials/page.tsx` — 資料管理（含上傳 Zone）
6. `(app)/projects/[projectId]/members/page.tsx` — 成員管理
7. `(app)/projects/[projectId]/history/page.tsx` — 編輯歷史
8. `(app)/projects/[projectId]/meetings/page.tsx` — 專案會議清單
9. `(app)/projects/[projectId]/meetings/[meetingId]/page.tsx` — 會議詳情（ACTIVE / ENDED / FAILED 三態）
10. `(app)/meetings/page.tsx` — 全局 Meetings 頁面
11. `(app)/meetings/[meetingId]/page.tsx` — 無關聯專案的會議詳情

### 2.7 關鍵 Component 細節

**`UploadZone` + `UploadStagingDialog`**：
- react-dropzone 處理三種上傳方式（點擊、剪貼簿、拖拉）
- 暫存區顯示後，確認才呼叫 `POST /materials`

**`LiveTranscript`**：
- `useLiveTranscriptions(projectId, meetingId, isActive)` 驅動
- 自動捲動到底部（新 segment 進來）

**`MeetingSummary`**：
- `summary === null` → 顯示 spinner「蜜塔正在生成摘要…」
- `summary === ''` → 顯示「此次會議無摘要可顯示」
- `summary` 有值 → 顯示摘要內容

**`PermissionGuard`**：
- 依 `05-前端架構.md §七` 實作，用於條件渲染需要特定權限的 UI

---

## 三、本 Phase 的單元測試

### `tests/unit/frontend/hooks/use-live-transcriptions.test.ts`

需覆蓋的 cases：
1. 首次呼叫無 `since_start_time`（cursor 為 null）
2. 收到 segments 後 cursor 更新為 `at(-1).startTime`
3. 相同 `segmentId` 的 segment 被 Map upsert（去重）
4. `segmentId` 為 null 時退而用 `${startTime}-${text}` 作 key
5. `isActive = false` → 不輪詢

### `tests/unit/frontend/hooks/use-meeting.test.ts`

需覆蓋的 cases：
1. `status = PENDING` → `refetchInterval = 3000`
2. `status = ACTIVE` → `refetchInterval = 5000`
3. `status = ENDED` + `summary = null` → `refetchInterval = 5000`（繼續輪詢）
4. `status = ENDED` + `summary = ''` → `refetchInterval = false`（停止）
5. `status = ENDED` + `summary = 'content'` → `refetchInterval = false`（停止）
6. `status = FAILED` → `refetchInterval = false`（停止）

### `tests/unit/frontend/components/indexing-status-badge.test.tsx`

1. PENDING → 顯示「等待中」
2. PROCESSING → 顯示「索引中」
3. COMPLETED → 顯示「索引完成」
4. FAILED → 顯示「索引失敗」

### `tests/unit/frontend/components/permission-guard.test.tsx`

1. 權限符合 → 渲染 children
2. 權限不符 → 渲染 fallback（預設不渲染）

---

## 四、Definition of Done

- [ ] 完整走完「建立專案 → 上傳 PDF → 等待索引完成 → 建立會議 → Bot 加入 → 在 Meet 問問題 → Bot 回答 → 離開會議 → 摘要出現」
- [ ] 非 Owner 看不到「刪除專案」按鈕（PermissionGuard 生效）
- [ ] 手機版側邊欄可收合（shadcn Sheet 元件）
- [ ] `npx vitest run` 所有測試通過
- [ ] 更新 `CLAUDE.md` 標記 P7 完成

---

*文件結尾*