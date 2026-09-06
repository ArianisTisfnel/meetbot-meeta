# API 設計文件

> 🟢 **活文件**：須與目前程式碼同步，可當現行規格參考。若與程式不符，以程式為準並回寫本文件。最後對齊：2026-06-04。

|項目|內容|
|----|-----|
|文件版本|v1.9|
|撰寫日期|2026-06-04|
|依據文件|`02-使用者需求.md`、`03-資料庫Schema設計.md`|
|後端框架|Hono（Node.js）|
|Base URL（開發）|`http://localhost:4000`|

---

## 一、認證策略

> 2026-08 起身份層由 app 自管（`app.users` / `app.user_tokens`），
> 不再有 Vexa 的 `public.api_tokens`、也不再有 token scope 的概念。

### 1.1 Token 流程

```
使用者登入（NextAuth + Google OAuth）
  └→ NextAuth jwt callback 拿已驗證的 email 打後端 POST /internal/token
     （header: x-internal-secret: <INTERNAL_AUTH_SECRET>）
  └→ 後端 get-or-create app.users，回一顆未過期的 app.user_tokens.token
  └→ 存進 session，前端以 session.authToken 取用
     ⚠️ INTERNAL_AUTH_SECRET 沒設或前後端不同值時，登入**仍會成功**但 authToken 是 null，
        之後每個 API 都 401。前端會在 server log 印明確錯誤（見 frontend/src/lib/auth.ts）。

前端呼叫 App Backend
  └→ Header: Authorization: Bearer <authToken>
  └→ Backend 驗證：prisma.userToken.findUnique({ where: { token }, include: { user: true } })
     並檢查 expiresAt（null = 永不過期）
  └→ 無需另行簽發或驗簽 JWT，token 本身即為身份憑證

Backend 呼叫 bot provider（Recall.ai）
  └→ 用服務自己的 RECALL_API_KEY，與使用者 token 無關
     （Vexa 時代要用「邀請者本人的 token」才能訂閱該會議的 WS，Recall 沒有這個限制）
```

### 1.2 統一請求 Header

```
Authorization: Bearer <authToken>
Content-Type: application/json   （非檔案上傳時）
```

### 1.3 後端從 Token 取得使用者資訊

後端 Hono middleware 每次請求時執行（`backend/src/middleware/auth.ts`）：

```typescript
const token = c.req.header('Authorization')?.replace('Bearer ', '')
if (!token) return c.json({ error_code: 'UNAUTHORIZED' }, 401)

const userToken = await prisma.userToken.findUnique({
  where: { token },
  include: { user: true },
})
if (!userToken || (userToken.expiresAt && userToken.expiresAt < new Date())) {
  return c.json({ error_code: 'UNAUTHORIZED' }, 401)
}

c.set('userId', userToken.user.id)
c.set('userEmail', userToken.user.email)
c.set('userName', userToken.user.name)
c.set('maxConcurrentBots', userToken.user.maxConcurrentBots)
```

### 1.4 `POST /internal/token`（內部端點，非公開 API）

前端登入專用，以共享密鑰 `INTERNAL_AUTH_SECRET` 驗證，**不走 auth middleware**。

| 情況 | 回應 |
|------|------|
| 後端未設 `INTERNAL_AUTH_SECRET` | `503`（端點停用） |
| `x-internal-secret` 不符 | `401` |
| 缺 `email` | `400 INVALID_REQUEST` |
| 正常 | `200 { "token": "..." }`（重用未過期的既有 token，不會每次登入都新發一顆） |

---

## 二、統一錯誤格式

所有 4xx / 5xx 回應使用統一格式：

```typescript
interface ErrorResponse {
  error_code: string     // 機器可讀的錯誤碼（全大寫 + 底線）
  message: string        // 人類可讀的說明
  details?: object       // 選填，提供額外上下文
}
```

### 常見錯誤碼

| HTTP 狀態碼 | error_code | 說明 |
|------------|-----------|------|
| 400 | `INVALID_REQUEST` | 請求格式錯誤（Zod 驗證失敗也回此碼） |
| 400 | `SELF_INVITE` | 擁有者邀請自己 |
| 401 | `UNAUTHORIZED` | 未提供或無效的 token |
| 403 | `PERMISSION_DENIED` | 已認證但無此操作權限（非 owner/member） |
| 403 | `EMAIL_MISMATCH` | 接受邀請者的登入 email 與被邀請 email 不符 |
| 404 | `NOT_FOUND` | 資源不存在 |
| 404 | `INVALID_INVITATION` | 邀請不存在或連結（token）無效 |
| 404 | `USER_NOT_FOUND` | `GET /users/lookup` 查無此 email（**僅 lookup 使用**；邀請流程不再用此碼） |
| 409 | `DUPLICATE_FILE` | 相同檔案已存在於此專案 |
| 409 | `ALREADY_MEMBER` | 使用者已是此專案的成員 |
| 409 | `ALREADY_INVITED` | 此 email 已有待處理邀請（請改用「重寄」） |
| 409 | `INVITATION_NOT_PENDING` | 邀請已非 PENDING（已接受/撤銷/拒絕），無法重寄或撤銷 |
| 409 | `BOT_CONCURRENT_LIMIT` | 使用者已達 Bot 並發上限 |
| 410 | `INVITATION_EXPIRED` | 邀請連結已過期 |
| 413 | `FILE_TOO_LARGE` | 超過 15 MB 限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 不支援的檔案格式 |
| 500 | `INTERNAL_ERROR` | 伺服器內部錯誤 |
| 503 | `EXTERNAL_SERVICE_ERROR` | Dify / Supabase / Recall 呼叫失敗 |

> ⚠️ `USER_NOT_FOUND` 僅 `GET /users/lookup` 使用（舊名 `USER_NOT_FOUND_IN_VEXA`，2026-08 改名）。
> 邀請流程已改為「可邀請尚未註冊者」，不再因查無帳號而報錯（見 §六 `POST .../members`）。
>
> ⚠️ 2026-08 移除的錯誤碼：`INSUFFICIENT_SCOPE`（token 不再有 scope）、
> `CREATOR_TOKEN_UNAVAILABLE`（不再用邀請者 token 取逐字稿）。

---

## 三、通用型別定義

```typescript
// 權限物件（附在 project 相關回應中，代表當前使用者的權限）
interface UserPermissions {
  canView: boolean
  canEdit: boolean
  canDelete: boolean    // 只有 owner 為 true
  canManage: boolean    // 只有 owner 為 true
  canMeeting: boolean   // owner 永遠為 true；參與者由 owner 透過 PATCH .../members/:uid 授予
}

// 使用者摘要（從 public.users 讀取）
interface UserSummary {
  userId: number
  email: string
  name: string | null
}

// 分頁包裝
interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  perPage: number
}
```

---

## 四、使用者 API

### `GET /me`

取得當前使用者資訊（從 authToken 查詢 public.api_tokens + public.users）。

**Response 200**
```json
{
  "userId": 123,
  "email": "user@example.com",
  "name": "User Name",
  "maxConcurrentBots": 1,
  "activeBotCount": 0
}
```

> `activeBotCount`：查詢此使用者目前有多少個 `ACTIVE` 狀態的 MeetingInstance，
> 讓前端判斷是否能再邀請 Bot。
> ⚠️ 此數字不含 `PENDING` 狀態，故在建立流程的數秒窗口內可能低估一個。
> 真正的並發門限在建立會議時以 DB 的 ACTIVE 計數把關（見§八 建立流程步驟③）。

---

### `GET /users/lookup?email=:email`

依 email 查找已註冊使用者（供邀請參與者時的輸入驗證，不分大小寫）。
**只有已登入使用者可呼叫，不開放匿名。**

**Response 200**
```json
{
  "userId": 456,
  "email": "member@example.com",
  "name": "Member Name"
}
```

**Response 404**
```json
{
  "error_code": "USER_NOT_FOUND",
  "message": "此 email 尚未在系統中建立帳號，請對方先登入後再試"
}
```

---

## 五、專案 API

### `GET /projects`

取得當前使用者有關聯的所有專案（包含身為 owner 與 participant 的）。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `search` | — | 依專案名稱搜尋（模糊匹配） |
| `type` | `all` | 篩選類型（`all` / `owned`：使用者為 Owner / `shared`：使用者為 Participant） |
| `order` | `desc` | 排序方向（`asc` / `desc`，依建立時間） |
| `page` | 1 | 頁碼 |
| `per_page` | 20 | 每頁筆數 |

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "Q3 產品規劃",
      "role": "owner",
      "permissions": {
        "canView": true, "canEdit": true, "canDelete": true,
        "canManage": true, "canMeeting": true
      },
      "memberCount": 3,
      "materialCount": 7,
      "activeMeetingCount": 1,
      "unread": {
        "total": 4,
        "activityCount": 3,
        "rsvpCount": 1,
        "sections": {
          "materials": 2, "meetings": 0, "calendar": 2, "members": 0, "history": 0
        }
      },
      "createdAt": "2026-05-20T08:00:00Z"
    },
    {
      "id": "uuid",
      "name": "行銷企劃",
      "role": "member",
      "permissions": {
        "canView": true, "canEdit": true, "canDelete": false,
        "canManage": false, "canMeeting": false
      },
      "memberCount": 5,
      "materialCount": 12,
      "activeMeetingCount": 0,
      "unread": {
        "total": 0,
        "activityCount": 0,
        "rsvpCount": 0,
        "sections": {
          "materials": 0, "meetings": 0, "calendar": 0, "members": 0, "history": 0
        }
      },
      "createdAt": "2026-05-10T09:00:00Z"
    }
  ],
  "total": 2
}
```

**`unread` 欄位**（紅點）

紅點掛在**分頁**上：哪裡有變動就在哪裡亮。`sections` 是各分頁的未讀數，
專案卡右上角那顆顯示的是 `total`。

| 欄位 | 來源 | 何時歸零 |
|------|------|---------|
| `activityCount` | `activity_logs` 中 `created_at > 該分頁的 lastReadAt` 且 `actor` 不是自己 | 打開**那個分頁**（`POST /projects/:id/read`） |
| `rsvpCount` | 我是與會者但 `rsvp = PENDING`、且會議未結束／未取消（算在 `sections.calendar`） | 真的回覆出席之後 |
| `total` | 上面兩者相加，恆等於 `sections` 各值之和 | — |

**活動歸屬哪個分頁**——刻意是一對一的分割，`sections` 相加才會等於 `total`：

| ActivityAction | section |
|----------------|---------|
| `MATERIAL_UPLOAD` / `MATERIAL_DELETE` | `materials` |
| `MEMBER_INVITE` / `MEMBER_ADD` / `MEMBER_REMOVE` / `MEMBER_PERMISSION_UPDATE` | `members` |
| `MEETING_CREATE`（立刻開一場）/ `MEETING_DELETE` | `meetings` |
| `MEETING_SCHEDULE`（行事曆上排定未來的會議） | `calendar` |
| `PROJECT_RENAME` | `history` |

> `MEETING_CREATE` 與 `MEETING_SCHEDULE` 是兩種不同的事件，就是為了讓排會議亮在行事曆、
> 立刻開會亮在會議。`PROJECT_RENAME` 沒有專屬分頁（專案名在頁首），唯一列得出它的地方是歷史。

已讀是**分頁**等級：進資料頁只清掉資料的紅點，不會把還沒看的成員異動一起蓋掉。
沒有已讀紀錄時的起算點：owner 從**專案建立時間**、成員從**被加入的時間**。
用專案建立時間當所有人的起點，新成員一進來就會背著幾百則舊動態。

---

### `GET /projects/:projectId/notifications`

未讀明細，前端點開圓點時才呼叫。待回覆的會議排在前面（那是要動手的事）。

**Response 200**
```json
{
  "rsvpItems": [
    {
      "meetingId": "uuid",
      "name": "Q3 進度同步",
      "scheduledStartAt": "2026-09-10T02:00:00Z",
      "scheduledEndAt": "2026-09-10T03:00:00Z"
    }
  ],
  "activityItems": [
    {
      "id": "uuid",
      "action": "MATERIAL_UPLOAD",
      "section": "materials",
      "targetLabel": "spec.pdf",
      "actor": { "userId": 2, "email": "bee@example.com", "name": "小蜂" },
      "createdAt": "2026-09-02T00:00:00Z"
    }
  ],
  "unread": {
    "total": 2,
    "activityCount": 1,
    "rsvpCount": 1,
    "sections": {
      "materials": 1, "meetings": 0, "calendar": 1, "members": 0, "history": 0
    }
  }
}
```

`activityItems` 最多回 20 筆（圓點不是活動紀錄頁，看全部請去 `/projects/:id/history`）。

**錯誤**：`404 NOT_FOUND`（專案不存在）、`403 PERMISSION_DENIED`（無檢視權限）

---

### `POST /projects/:projectId/read`

標記已讀。前端切到某個分頁時自動呼叫。

**Request**（body 可省略）
```json
{ "section": "materials" }
```

給了 `section` 就只清那個分頁的紅點；**不給就五個分頁一起清**（「全部標為已讀」用）。
`section` 可選值：`materials` / `meetings` / `calendar` / `members` / `history`。

**Response 200**
```json
{ "projectId": "uuid", "sections": ["materials"], "lastReadAt": "2026-09-02T05:30:00Z" }
```

⚠️ 只清掉 `activityCount`。`rsvpCount` 是待辦不是消息，
打開分頁不算「處理過」，要按了出席／不出席才會消失。

---

### `POST /projects`

建立新專案。建立時同步呼叫 Dify API 建立 Knowledge Base。

**Request**
```json
{
  "name": "新專案名稱"
}
```

**Response 201**
```json
{
  "id": "uuid",
  "name": "新專案名稱",
  "role": "owner",
  "permissions": {
    "canView": true, "canEdit": true, "canDelete": true,
    "canManage": true, "canMeeting": true
  },
  "createdAt": "2026-05-26T10:00:00Z"
}
```

**建立流程（後端）：**
```
① 驗證 Google Meet URL 格式，解析出 nativeMeetingId
   （backend/src/lib/google-meet.ts：從 URL 抓 3-4-3 的 Meet code，例 abc-defg-hij）
② 專案會議：驗證 canMeeting 權限，取得該專案的 difyDatasetId
③ 檢查邀請者的 activeBotCount < max_concurrent_bots → 否則 409
   activeBotCount = 此使用者 status = 'ACTIVE' 的 MeetingInstance 數量
④ Prisma create MeetingInstance（status: PENDING）+ 寫 activity_log（專案會議才寫）
⑤ 背景（不阻塞回應）呼叫 startBotSession()：
   ↳ 透過 provider 抽象層向 Recall 派 bot，並等待 admission（RECALL_ADMISSION_TIMEOUT_MS，預設 90s）
   ↳ admitted → DB 轉 ACTIVE、記錄 startedAt 與 nativeMeetingId，發歡迎訊息
   ↳ 進不去（被擋在等候室 / 逾時 / dispatch 失敗）→ DB 轉 FAILED
   ⚠️ 回應在此之前就回去了，狀態維持 PENDING，前端沿用「PENDING→ACTIVE」輪詢 UX
```

> **為什麼 DB 不在 dispatch 成功當下就轉 ACTIVE**：bot 要歷經 dispatch → 等候室 → 被准入，
> 中間隨時可能被擋。ACTIVE 的語意是「蜜塔真的在會議裡」——並發上限、前端狀態都靠它，
> 提前設會讓使用者以為成功、也會佔掉並發額度。

**Error cases**
```json
// 409：Bot 並發上限
{ "error_code": "BOT_CONCURRENT_LIMIT", ... }
```

---

### `GET /meetings`

取得當前使用者所有相關會議實例（跨專案整合 + 無關聯專案的獨立會議）。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` | 1 | |
| `per_page` | 20 | |
| `search` | — | 依會議名稱或關聯專案名稱搜尋（模糊匹配） |
| `since` | — | 篩選最近 N 天內的會議（可選值：`1` / `3` / `7`） |
| `order` | `desc` | 排序方向（`asc` / `desc`，依 `created_at`） |
| `status` | — | 篩選狀態（`PENDING` / `ACTIVE` / `ENDED` / `FAILED`） |

> **回傳範圍**：該使用者**建立**的所有會議，加上所屬專案中具備**檢視權**的所有會議。

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "每週同步會議",
      "status": "ACTIVE",
      "projectId": "uuid",
      "projectName": "Q3 產品規劃",
      "startedAt": "2026-05-26T10:05:00Z",
      "endedAt": null,
      "createdAt": "2026-05-26T10:00:00Z"
    },
    {
      "id": "uuid",
      "name": "臨時會議",
      "status": "ENDED",
      "projectId": null,
      "projectName": null,
      "startedAt": "2026-05-26T09:00:00Z",
      "endedAt": "2026-05-26T09:45:00Z",
      "createdAt": "2026-05-26T08:55:00Z"
    }
  ],
  "total": 15,
  "page": 1,
  "perPage": 20
}
```

---

### `GET /meetings/:meetingId`

全局存取單一會議詳細資訊（適用於無關聯專案的會議，或從 Meetings 頁面直接進入）。

**需要**：當前使用者為該會議的建立者，或具備關聯專案的**檢視權**。若無關聯專案則僅建立者可存取。

**Response 200**

回應格式同 `GET /projects/:projectId/meetings/:meetingId`，額外包含：
```json
{
  "projectId": null,      // 若無關聯專案為 null
  "projectName": null,
  ...（其餘欄位同專案內的會議詳情）
}
```

---

### `PATCH /meetings/:meetingId`

更新無關聯專案的會議名稱。**需要：建立者本人**。

**Request**
```json
{
  "name": "更新後的會議名稱"
}
```

**Response 200**
```json
{
  "id": "uuid",
  "name": "更新後的會議名稱",
  "updatedAt": "..."
}
```

---

### `POST /meetings/:meetingId/bot/leave`

讓 Bot 離開無關聯專案的會議。**需要：建立者本人**。
僅在 `status = ACTIVE` 時有效。

**Response 200**
```json
{
  "id": "uuid",
  "status": "ENDED",
  "endedAt": "2026-05-26T11:00:00Z"
}
```

**離開流程（後端）：**
```
① 呼叫 handleSessionClose(meetingInstanceId)——以下步驟由此函式原子執行：
   ⚠️ 不可拆開逐步執行：handleSessionClose 在首行即從 activeSessions Map 刪除 entry（原子鎖），
   確保 provider 同時送來的「bot 已結束」事件不會觸發第二次摘要生成。
   （詳見 06-後端架構.md § handleSessionClose）
② 請 provider 撤除 bot（botSession.adapter.leave()）
   ⚠️ 失敗只記 warn 不中斷：DB 一定要更新成 ENDED，否則會永遠卡在 ACTIVE 佔用並發額度。
③ 更新 MeetingInstance：status: ENDED、endedAt = now()
④ 觸發摘要工作流（非同步，回應 200 後在背景執行）
   ↳ 從記憶體中的 bot session 取全量逐字稿（會後補抓不回來，見 13 §已知限制）
   ↳ 格式化為 Markdown（含說話者標記與時間戳，格式見 06-後端架構.md § 6）
   ↳ 儲存至 Supabase Storage（路徑：transcripts/{meetingInstanceId}/transcript.md）
   ↳ 透過 Dify Files API（POST /files/upload）上傳 MD 檔（使用 DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY）→ 取得 upload_file_id
   ↳ 呼叫 Dify 會議摘要 Workflow（POST /workflows/run，MEETING_SUMMARY_WORKFLOW_API_KEY，inputs.transcript 以 file 物件傳入）
   ↳ 解析 data.outputs.result_json → 取得 meeting_title、summary、key_topics、decisions、action_items（格式：[{task, owner}]）
   ↳ 更新 MeetingInstance.summary + actionItems + transcriptStoragePath
```

> **授權一致性**：`bot/leave`、`cancel`、`reinvite` 的專案版 route **皆已在後端強制 `canMeeting`**：
> 前兩者透過 `meeting.service.requireProjectMeetingManageAccess`（Owner 或 canMeeting + 確認會議屬此專案），
> `reinvite` 由 `reinviteBot` service 內部驗證（建立者 / owner / canMeeting）。前端按鈕亦以 `canMeeting` 控制顯示。

---

### `POST /projects/:projectId/meetings/:meetingId/cancel`

取消專案內**等待中（PENDING）**的會議。**需要：會議權**（設計意圖；後端現況見上方授權備註）。
行為同全局 `POST /meetings/:meetingId/cancel`：撤 Bot、關 WS、標記 FAILED、不觸發摘要。

**Response 200**：`{ "id": "uuid", "status": "FAILED", "endedAt": "..." }`

---

### `POST /projects/:projectId/meetings/:meetingId/bot/reinvite`

重新邀請蜜塔加入專案內既有會議（`FAILED`/`ENDED`/卡住的 `PENDING`）。**需要：會議權（Owner 或 `canMeeting` 參與者，或建立者本人）**——此端點由 `reinviteBot` 在 service 內部確實驗證。

行為同全局 reinvite：`ENDED` 會議**不覆寫原紀錄**，另建新 `MeetingInstance` 並回傳新 id；`FAILED`/卡住的 `PENDING` 就地重置回傳原 id。

**Response 200**：`{ "id": "uuid", "status": "PENDING" }`（`id` 於 ENDED 重邀時為**新**會議實例的 id）

**Error cases**：同全局 reinvite（`400`/`403 PERMISSION_DENIED`/`409 BOT_CONCURRENT_LIMIT`）。

---

### `GET /projects/:projectId/meetings/:meetingId/transcriptions`

取得會議逐字稿。**需要：檢視權**。

> **實作注意（逐字稿只存在於記憶體）**：
>
> 逐字稿由 Recall 的 webhook 即時推進來，累積在 in-memory 的 bot session；
> `GET .../transcriptions` 一律從 `activeSessions.get(meetingInstanceId)?.botSession` 取，
> 再依 `since_start_time` 在記憶體過濾、排序、分頁。
>
> ⚠️ **session 不在記憶體時（會議已結束或後端重啟過）回空陣列**，不是錯誤碼。
> 後端會留一行 warn log。移除 Vexa 之前還有「用邀請者 token 打 Vexa REST 重抓」這條退路
> （對應已移除的 `503 CREATOR_TOKEN_UNAVAILABLE`），現在沒有了。
> 根治要讓 segment 落 DB，見 `docs/13-系統現況與路線圖.md § 已知限制`。
>
> - **ACTIVE 會議**：前端以 3 秒輪詢 `?since_start_time=<last_end_time>` 取得新 segments
> - **ENDED 會議**：只要後端沒重啟過就還取得到；重啟後為空，改看會後的 Markdown 逐字稿
>   （`GET .../transcript`，那份有落 Storage）
>
> 具體實作見 `backend/src/services/transcription.service.ts`。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` | 1 | 僅用於 ENDED 會議 |
| `per_page` | 50 | 僅用於 ENDED 會議 |
| `since_start_time` | — | 取得 start_time >= N（秒）的 segments（ACTIVE/ENDED 皆適用；含邊界值，前端以 segment_id 去重） |

**Response 200**
```json
{
  "items": [
    {
      "text": "蜜塔，請問這份規則文件是最新版嗎？",
      "speaker": "Speaker 1",
      "startTime": 123.45,
      "endTime": 128.90,
      "language": "zh",
      "segmentId": "seg-001",
      "createdAt": "2026-05-26T10:15:00Z"
    }
  ],
  "total": 150,
  "page": 1,
  "perPage": 50
}
```

> 進行中的會議（ACTIVE）：前端以每 3 秒輪詢 `?since_start_time=<last_end_time>` 取得新 segments。
> 結束的會議（ENDED）：逐字稿為靜態資料，前端一次性取完即可；可搭配 `page`/`per_page` 分頁讀取。

---

## 十、權限矩陣總覽

| Endpoint | Owner | 參與者（has canView） | 參與者（has canEdit） | 參與者（has canMeeting） | 任意登入使用者 |
|----------|-------|---------------------|---------------------|------------------------|--------------|
| `GET /me` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /users/lookup` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /me/invitations` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /me/invitations/:id/accept`、`/decline`、`/accept-by-token` | ✅ | ✅ | ✅ | ✅ | ✅（email 相符者）|
| `POST /meetings`（全局建立） | ✅ | ✅ | ✅ | ✅ | ✅（projectId 留空時）|
| `GET /meetings`（全局列表） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /meetings/:mid`（全局存取） | ✅ | ✅ | ✅ | ✅ | ✅（建立者）|
| `PATCH /meetings/:mid`（全局改名） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `POST /meetings/:mid/bot/leave`（全局停止） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `POST /meetings/:mid/cancel`（全局取消 PENDING） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `POST /meetings/:mid/bot/reinvite`（全局重邀） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `GET /meetings/:mid/transcriptions`（全局逐字稿） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `GET /projects` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /projects` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /projects/:id` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `PATCH /projects/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `DELETE /projects/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET .../members` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST .../members`（建立邀請） | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST .../invitations/:id/resend` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `DELETE .../invitations/:id`（撤銷） | ✅ | ❌ | ❌ | ❌ | ❌ |
| `PATCH .../members/:uid` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `DELETE .../members/:uid` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST .../materials`（上傳） | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET .../materials` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `GET .../materials/:mid` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `DELETE .../materials/:mid` | ✅ | ❌ | ✅ | ❌ | ❌ |
| `GET .../history` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST /projects/.../meetings`（專案內建立） | ✅ | ❌ | ❌ | ✅² | ❌ |
| `GET /projects/.../meetings` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `GET /projects/.../meetings/:mid` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `PATCH /projects/.../meetings/:mid` | ✅ | ❌ | ❌ | ✅² | ❌ |
| `GET /projects/.../meetings/:mid/transcriptions` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST /projects/.../meetings/:mid/bot/leave` | ✅ | ❌ | ❌ | ✅² | ❌ |
| `POST /projects/.../meetings/:mid/cancel` | ✅ | ❌ | ❌ | ✅² | ❌ |
| `POST /projects/.../meetings/:mid/bot/reinvite` | ✅ | ❌ | ❌ | ✅² | ❌ |

> ¹ **全局無關聯專案端點**（`PATCH /meetings/:mid`、`POST /meetings/:mid/bot/leave`、`GET /meetings/:mid/transcriptions`）：
> 授權邏輯為 `userId === meeting.createdByUserId`（**建立者本人**），不涉及專案成員權限。
>
> ² **會議操作（建立、改名、結束、取消、重邀）需要 `canMeeting`**：
> Owner 永遠具備此權限；參與者的 `canMeeting` 預設為 `false`，
> 需由 Owner 透過 `PATCH .../members/:uid` 授予。
> 設計動機：所有者無法出席時，可授權信任的參與者代為主持（邀請 Bot、開啟/結束會議）。
>
> **全局 `POST /meetings` 的 projectId 驗證**：
> - `projectId` 留空 → 任意登入使用者皆可建立（獨立會議）
> - `projectId` 有值 → 需具備該專案的**會議權**（`canMeeting`），否則 403 PERMISSION_DENIED

---

## 十一、後端 Background Jobs

以下為不對外暴露的後端定期任務，於 Hono 服務啟動時一起運行：

### 10.1 Dify 索引狀態輪詢

- **觸發頻率**：每 30 秒
- **邏輯**：查詢 `indexingStatus = PENDING 或 PROCESSING` 的 materials，呼叫 Dify API 更新狀態
  （PENDING 表示剛上傳、Dify 尚未開始處理，也需持續輪詢直到 Dify 回傳第一次狀態）
- **相關 Dify endpoint**：`GET /datasets/{dataset_id}/documents/{batch}/indexing-status`
  （URL 中使用 `batch` 而非 `document_id`；`batch` 儲存於 `materials.dify_batch` 欄位）

```typescript
// 每 30 秒執行
setInterval(async () => {
  const processing = await prisma.material.findMany({
    where: { indexingStatus: { in: ['PENDING', 'PROCESSING'] }, deletedAt: null },
    include: { project: { select: { difyDatasetId: true } } }
  })
  for (const material of processing) {
    if (!material.difyBatch) continue
    const status = await dify.getIndexingStatus(
      material.project.difyDatasetId,
      material.difyBatch    // ← 使用 batch，非 difyDocumentId
    )
    await prisma.material.update({ where: { id: material.id }, data: { indexingStatus: status } })
  }
}, 30_000)
```

### 10.2 MeetingSession 管理

- **觸發**：`POST .../meetings` 成功建立會議實例時
- **邏輯**：為每個 ACTIVE 會議維護一個 `MeetingSession` 物件（WebSocket + 喚醒詞偵測）
- **詳見**：`03-資料庫Schema設計.md` 第 4.6 節

### 10.3 摘要工作流

- **觸發**：Bot 離開會議（`POST .../bot/leave` 或 provider 回報 bot 結束）
- **邏輯**：從記憶體中的 bot session 取全量逐字稿 → 格式化為 Markdown → 存至 Supabase Storage → 上傳 MD 檔至 Dify Files API → 呼叫 Dify 摘要工作流（以 file 傳入）生成摘要與交辦事項 → 更新 MeetingInstance
- **非同步執行**：回應 200 後在背景執行，完成後透過前端輪詢可見結果

---

## 十二、前端輪詢策略（Real-time）

本專案採用**客戶端輪詢**取代 WebSocket/SSE，降低實作複雜度：

| 場景 | 輪詢 Endpoint | 頻率 | 停止條件 |
|------|-------------|------|---------|
| 檔案索引狀態 | `GET .../materials/:id` | 5 秒 | `indexingStatus` 不再是 PROCESSING |
| 會議 Bot 加入中 | `GET .../meetings/:id` | 3 秒 | `status` 變為 ACTIVE 或失敗 |
| 進行中會議逐字稿 | `GET .../transcriptions?since_start_time=X` | 3 秒 | `status` 變為 ENDED |
| 會議摘要生成中 | `GET .../meetings/:id` | 5 秒 | `summary` 不再為 null |

---

## 十三、環境變數

> **環境變數正本見 `06-後端架構.md §十`**（完整清單，避免多處重複而 drift）。
> 含 Hono server（`APP_PORT`/`APP_CORS_ORIGINS`/`APP_BASE_URL`）、Dify 四把 key 與 `DIFY_CHATFLOW_TIMEOUT_MS`、
> Anthropic、Recall、Supabase、邀請信 SMTP（`SMTP_*`/`MAIL_FROM`/`INVITATION_TTL_DAYS`）等。

> `NEXTAUTH_SECRET` 僅前端（Next.js）使用，後端不需要。
> 後端認證改由查詢 `public.api_tokens` 驗證 authToken，詳見第一節。

---

*文件結尾*
