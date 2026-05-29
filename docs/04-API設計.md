# API 設計文件

|項目|內容|
|----|-----|
|文件版本|v1.8|
|撰寫日期|2026-05-29|
|依據文件|`02-使用者需求.md`、`03-資料庫Schema設計.md`|
|後端框架|Hono（Node.js）|
|Base URL（開發）|`http://localhost:4000`|

---

## 一、認證策略

### 1.1 Token 流程

```
使用者登入（NextAuth）
  └→ 前端從 NextAuth session 取得 vexaToken（由 Vexa 原本的 session callback 注入）

前端呼叫 App Backend
  └→ Header: Authorization: Bearer <vexaToken>
  └→ Backend 驗證：查詢 public.api_tokens WHERE token = vexaToken
  └→ JOIN public.users 取得 user_id、email、max_concurrent_bots 等使用者資訊
  └→ 無需另行簽發或驗簽 JWT，vexaToken 本身即為身份憑證

Backend 呼叫 Vexa Bot API（例如邀請 Bot、傳送訊息）
  └→ 直接使用前端送來的 vexaToken
  └→ Header: X-API-Key: <vexaToken>
  └→ ⚠️ 此 token 必須具備 bot、browser、tx 三個 scope（Vexa api-gateway 分路徑各自驗證：
     /bots 需要 {"bot","browser"}；/transcripts 需要 {"tx"}）
     meetbot auth middleware 在 token 驗證時統一預檢三個 scope：
     缺少任一項時雖 /bots 本身不會被 Vexa 擋下，但後續逐字稿查詢（含 generateSummaryAsync）
     會以 Vexa 403 失敗；前置統一檢查確保錯誤在 meetbot 層給出明確的 INSUFFICIENT_SCOPE 訊息
```

### 1.2 統一請求 Header

```
Authorization: Bearer <vexaToken>
Content-Type: application/json   （非檔案上傳時）
```

### 1.3 後端從 Token 取得使用者資訊

後端 Hono middleware 每次請求時執行：

```typescript
// 偽代碼（實際使用 Prisma 查詢 public schema）
const token = c.req.header('Authorization')?.replace('Bearer ', '')
if (!token) return c.json({ error_code: 'UNAUTHORIZED' }, 401)

const apiToken = await db.api_tokens.findFirst({
  where: { token, OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] }
  // scopes 為 text[]（PostgreSQL array），注入供 handler 前置 scope 檢查
})
if (!apiToken) return c.json({ error_code: 'UNAUTHORIZED' }, 401)

const user = await db.users.findUnique({ where: { id: apiToken.user_id } })
c.set('vexaUserId', user.id)
c.set('userEmail', user.email)
c.set('maxConcurrentBots', user.max_concurrent_bots)
c.set('vexaToken', token)            // 供後續 handler 呼叫 Vexa API 時使用
c.set('vexaTokenScopes', apiToken.scopes as string[])  // 供 scope 前置檢查
```

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
| 400 | `INVALID_REQUEST` | 請求格式錯誤 |
| 401 | `UNAUTHORIZED` | 未提供或無效的 token |
| 403 | `PERMISSION_DENIED` | 已認證但無此操作權限（非 owner/member） |
| 403 | `INSUFFICIENT_SCOPE` | vexaToken 缺少 bot/browser/tx scope |
| 404 | `NOT_FOUND` | 資源不存在 |
| 409 | `DUPLICATE_FILE` | 相同檔案已存在於此專案 |
| 409 | `ALREADY_MEMBER` | 使用者已是此專案的參與者 |
| 409 | `BOT_CONCURRENT_LIMIT` | 使用者已達 Bot 並發上限 |
| 413 | `FILE_TOO_LARGE` | 超過 15 MB 限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 不支援的檔案格式 |
| 422 | `USER_NOT_FOUND_IN_VEXA` | email 尚未在 Vexa 建立帳號 |
| 500 | `INTERNAL_ERROR` | 伺服器內部錯誤 |
| 503 | `EXTERNAL_SERVICE_ERROR` | Dify / Supabase / Vexa 呼叫失敗 |

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
  vexaUserId: number
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

取得當前使用者資訊（從 vexaToken 查詢 public.api_tokens + public.users）。

**Response 200**
```json
{
  "vexaUserId": 123,
  "email": "user@example.com",
  "name": "User Name",
  "maxConcurrentBots": 1,
  "activeBotCount": 0
}
```

> `activeBotCount`：查詢此使用者目前有多少個 `ACTIVE` 狀態的 MeetingInstance，
> 讓前端判斷是否能再邀請 Bot。
> ⚠️ 此數字不含 `PENDING` 狀態，故在建立流程的數秒窗口內可能低估一個。
> 真正的並發門限由 Vexa POST /bots 的 403 捕捉（見建立流程步驟④），保證最終一致。

---

### `GET /users/lookup?email=:email`

依 email 查找 Vexa 使用者（供邀請參與者時的輸入驗證）。
**只有已登入使用者可呼叫，不開放匿名。**

**Response 200**
```json
{
  "vexaUserId": 456,
  "email": "member@example.com",
  "name": "Member Name"
}
```

**Response 404**
```json
{
  "error_code": "USER_NOT_FOUND_IN_VEXA",
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
      "createdAt": "2026-05-10T09:00:00Z"
    }
  ],
  "total": 2
}
```

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
① 呼叫 Dify API 建立 dataset → 取得 dify_dataset_id
② Prisma create Project（含 dify_dataset_id、owner_vexa_user_id）
   ↳ 若 ① 失敗 → 5xx，無需清理
   ↳ 若 ② 失敗 → 刪除 Dify dataset（rollback）
```

---

### `GET /projects/:projectId`

取得專案詳細資訊。需具備此專案的任一存取權（owner 或有效 participant）。

> **「有效 participant」定義**：project_members 中存在且**至少一項權限為 true**（canView、canEdit、canMeeting 之一）的成員。
> 若所有權限欄位均為 false，視同無效，回傳 **403 PERMISSION_DENIED**。

**Response 200**
```json
{
  "id": "uuid",
  "name": "Q3 產品規劃",
  "role": "owner",
  "permissions": { "canView": true, ... },
  "owner": {
    "vexaUserId": 123,
    "email": "owner@example.com",
    "name": "Owner Name"
  },
  "memberCount": 3,
  "materialCount": 7,
  "activeMeetingCount": 1,
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

### `PATCH /projects/:projectId`

更新專案名稱。**需要：Owner**。

**Request**
```json
{
  "name": "更新後的名稱"
}
```

**Response 200**
```json
{
  "id": "uuid",
  "name": "更新後的名稱",
  "updatedAt": "..."
}
```

---

### `DELETE /projects/:projectId`

刪除專案（Soft delete）。**需要：Owner（刪除權）**。

**Response 204**（no body）

**刪除流程（後端）：**
```
① 對所有 materials 執行 soft delete + 清理 Storage 和 Dify 文件
② 刪除 Dify dataset
③ 設定 projects.deleted_at = now()
（material_edit_history、meeting_instances、project_members 保留）
```

---

## 六、成員管理 API

### `GET /projects/:projectId/members`

取得專案成員清單。**需要：檢視權**。

**Response 200**
```json
{
  "owner": {
    "vexaUserId": 123,
    "email": "owner@example.com",
    "name": "Owner Name"
  },
  "members": [
    {
      "id": "uuid",
      "vexaUserId": 456,
      "email": "member@example.com",
      "name": "Member Name",
      "canView": true,
      "canEdit": false,
      "canMeeting": false,
      "invitedAt": "2026-05-21T12:00:00Z"
    }
  ]
}
```

---

### `POST /projects/:projectId/members`

邀請新參與者。**需要：Owner（管理權）**。

**Request**
```json
{
  "email": "newmember@example.com",
  "canView": true,
  "canEdit": false,
  "canMeeting": false
}
```

**Response 201**
```json
{
  "id": "uuid",
  "vexaUserId": 789,
  "email": "newmember@example.com",
  "name": "New Member",
  "canView": true,
  "canEdit": false,
  "canMeeting": false,
  "invitedAt": "2026-05-26T10:00:00Z"
}
```

**Error cases**
```json
// 422：對方尚未登入系統
{ "error_code": "USER_NOT_FOUND_IN_VEXA", "message": "..." }

// 409：對方已是此專案成員
{ "error_code": "ALREADY_MEMBER", "message": "..." }
```

**邀請流程：**
```
① 呼叫 GET /users/lookup?email=... 確認使用者存在 → 取得 vexaUserId
② Prisma create ProjectMember
```

---

### `PATCH /projects/:projectId/members/:vexaUserId`

調整參與者權限。**需要：Owner（管理權）**。

**Request**
```json
{
  "canView": true,
  "canEdit": true,
  "canMeeting": true
}
```

> 三個欄位均為選填，只傳需要修改的欄位即可；未傳入的欄位保持原值。

**Response 200**
```json
{
  "id": "uuid",
  "vexaUserId": 456,
  "canView": true,
  "canEdit": true,
  "canMeeting": true,
  "updatedAt": "..."
}
```

---

### `DELETE /projects/:projectId/members/:vexaUserId`

移除參與者。**需要：Owner（管理權）**。
不可移除自己（Owner）。

**Response 204**（no body）

---

## 七、資料（Materials）API

### `POST /projects/:projectId/materials`

上傳資料檔案。**需要：編輯權**。

**Request**（`multipart/form-data`）

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `file` | binary | ✅ | 檔案本體 |
| `display_name` | string | ❌ | 顯示名稱，預設同檔名 |

**Response 201**
```json
{
  "id": "uuid",
  "filename": "company-rules.pdf",
  "displayName": "公司規則 v2",
  "sizeBytes": 1234567,
  "mimeType": "application/pdf",
  "indexingStatus": "PENDING",
  "uploadedBy": {
    "vexaUserId": 123,
    "name": "User Name"
  },
  "uploadedAt": "2026-05-26T10:00:00Z"
}
```

**Error cases**
```json
// 409：相同檔案已存在
{
  "error_code": "DUPLICATE_FILE",
  "message": "相同檔案已上傳至此專案",
  "details": { "existingMaterialId": "uuid" }
}

// 413：檔案過大
{ "error_code": "FILE_TOO_LARGE", "message": "檔案大小超過 15 MB 限制" }

// 415：不支援格式
{ "error_code": "UNSUPPORTED_MEDIA_TYPE", "message": "僅支援 PDF、DOCX、TXT、MD" }
```

**上傳流程（後端）：**
```
① 驗證格式（MIME type）、大小
② 計算 SHA-256，查詢是否有效重複 → 409
③ 上傳至 Supabase Storage（路徑：{projectId}/{uuid}/{filename}）
④ 呼叫 Dify API 上傳文件至專案的 dataset
⑤ Prisma create Material（含 difyDocumentId、difyBatch、storagePath）
⑥ Prisma create MaterialEditHistory（action: UPLOAD）
   ↳ 任一步驟失敗：逆序 rollback
```

---

### `GET /projects/:projectId/materials`

取得專案資料清單。**需要：檢視權**。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` | 1 | 頁碼 |
| `per_page` | 20 | 每頁筆數（max 100） |
| `status` | — | 篩選 indexingStatus（選填） |

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "filename": "company-rules.pdf",
      "displayName": "公司規則 v2",
      "sizeBytes": 1234567,
      "mimeType": "application/pdf",
      "indexingStatus": "COMPLETED",
      "uploadedBy": {
        "vexaUserId": 123,
        "name": "User Name"
      },
      "uploadedAt": "2026-05-26T10:00:00Z"
    }
  ],
  "total": 7,
  "page": 1,
  "perPage": 20
}
```

---

### `GET /projects/:projectId/materials/:materialId`

取得單一資料的詳細資訊（含最新索引狀態）。**需要：檢視權**。

**Response 200**
```json
{
  "id": "uuid",
  "filename": "company-rules.pdf",
  "displayName": "公司規則 v2",
  "sizeBytes": 1234567,
  "mimeType": "application/pdf",
  "indexingStatus": "FAILED",
  "indexingError": "Dify chunking failed: unsupported encoding",
  "uploadedBy": {
    "vexaUserId": 123,
    "name": "User Name"
  },
  "uploadedAt": "...",
  "updatedAt": "..."
}
```

---

### `DELETE /projects/:projectId/materials/:materialId`

刪除資料檔案（三方同步）。**需要：編輯權**。

**Response 204**（no body）

**刪除流程（後端）：**
```
① 呼叫 Dify API 刪除文件
② 從 Supabase Storage 刪除檔案
③ Prisma update Material（set deletedAt = now()）
④ Prisma create MaterialEditHistory（action: DELETE）
   ↳ 任一步驟失敗：記錄錯誤日誌，標記 material 狀態異常（不對使用者拋錯，後台補清理）
```

---

### `GET /projects/:projectId/history`

取得專案資料操作的歷史紀錄。**需要：檢視權**。

**Query Params**

| 參數 | 預設 |
|------|------|
| `page` | 1 |
| `per_page` | 20 |

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "action": "DELETE",
      "filenameSnapshot": "company-rules.pdf",
      "performedBy": {
        "vexaUserId": 123,
        "name": "User Name"
      },
      "performedAt": "2026-05-26T14:30:00Z"
    },
    {
      "id": "uuid",
      "action": "UPLOAD",
      "filenameSnapshot": "company-rules.pdf",
      "performedBy": {
        "vexaUserId": 123,
        "name": "User Name"
      },
      "performedAt": "2026-05-26T10:00:00Z"
    }
  ],
  "total": 25,
  "page": 1,
  "perPage": 20
}
```

---

## 八、全局會議 API

這組 API 不以專案為前綴，用於：全局建立會議（可不關聯專案）、跨專案的 Meetings 頁面列表。

### `POST /meetings`

全局建立會議實例，`projectId` 選填。**需要：登入使用者**（若提供 `projectId`，需具備該專案的**會議權**）。

**Request**
```json
{
  "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
  "name": "每週同步會議",
  "projectId": "uuid"    // 選填，省略則建立無關聯專案的獨立會議
}
```

**Response 201**
```json
{
  "id": "uuid",
  "name": "每週同步會議",
  "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
  "status": "PENDING",
  "projectId": "uuid",           // 若有關聯，否則為 null
  "projectName": "Q3 產品規劃",  // 若有關聯，否則為 null
  "createdBy": {
    "vexaUserId": 123,
    "name": "User Name"
  },
  "createdAt": "2026-05-26T10:00:00Z"
}
```

**建立流程（後端）：**
```
① 驗證 Google Meet URL 格式，解析 nativeMeetingId
   ↳ 確認 vexaTokenScopes 包含 'bot'、'browser'、'tx'，否則 403 INSUFFICIENT_SCOPE
② 若有 projectId：驗證當前使用者對該專案具備會議權（owner 或被授予 canMeeting 的參與者）→ 否則 403 PERMISSION_DENIED
   取得 project.difyDatasetId（供 MeetingSession 使用）
   若無 projectId：difyDatasetId = null（Bot 改以最近逐字稿為 context 透過 Claude 直接回答，不使用 Dify Chatflow）
③ 後續流程與 POST /projects/:projectId/meetings 相同（步驟②~⑤）
```

**Error cases**
```json
// 403：Token scope 不足
{ "error_code": "INSUFFICIENT_SCOPE", ... }

// 403：提供了 projectId 但無會議權
{ "error_code": "PERMISSION_DENIED", "message": "您對此專案沒有建立會議的權限" }

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

**離開流程（後端）：** 與 `POST /projects/:projectId/meetings/:meetingId/bot/leave` 相同（見§九），授權改為驗證 `vexaUserId === meeting.createdByVexaUserId`。

---

### `GET /meetings/:meetingId/transcriptions`

取得無關聯專案會議的逐字稿。**需要：建立者本人**。

> 實作方式與 `GET /projects/:projectId/meetings/:meetingId/transcriptions` 完全相同（見§九），
> 授權改為驗證 `vexaUserId === meeting.createdByVexaUserId`（無專案成員可查詢）。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` | 1 | 僅用於 ENDED 會議 |
| `per_page` | 50 | 僅用於 ENDED 會議 |
| `since_start_time` | — | 取得 start_time >= N（秒）的 segments（ACTIVE/ENDED 皆適用；含邊界值，前端以 segment_id 去重） |

**Response 200**（格式同§九的逐字稿端點）

---

## 九、專案內會議 API

### `POST /projects/:projectId/meetings`

建立會議實例並邀請 Bot。**需要：會議權（Owner 或被授予 `canMeeting` 的參與者）**。

**Request**
```json
{
  "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
  "name": "每週同步會議"
}
```
> `name` 選填，預設為 `"會議 {YYYY-MM-DD HH:mm}"`

**Response 201**
```json
{
  "id": "uuid",
  "name": "每週同步會議",
  "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
  "status": "PENDING",
  "vexaMeetingId": null,
  "createdBy": {
    "vexaUserId": 123,
    "name": "User Name"
  },
  "createdAt": "2026-05-26T10:00:00Z"
}
```

**建立流程（後端）：**
```
① 驗證 Google Meet URL 格式，解析出 nativeMeetingId
   支援兩種格式（與 Vexa `schemas.py construct_meeting_url` 一致）：
   - 標準碼（3-4-3）：^[a-z]{3}-[a-z]{4}-[a-z]{3}$
   - Workspace 自訂暱稱：^[a-z0-9][a-z0-9-]{3,38}[a-z0-9]$
   組合正則（從 URL 解析）：
   /meet\.google\.com\/((?:[a-z]{3}-[a-z]{4}-[a-z]{3})|(?:[a-z0-9][a-z0-9-]{3,38}[a-z0-9]))/
   ⚠️ 兩種格式都支援，企業 Workspace 用戶的自訂暱稱（如 my-weekly-standup）可正常使用；
      只支援標準格式會導致 Workspace 用戶的連結被 meetbot 拒絕但 Vexa 可接受
   ↳ 確認 c.var.vexaTokenScopes 包含 'bot'、'browser'、'tx'
     → 否則 403 INSUFFICIENT_SCOPE（在 DB 寫入前快速失敗，不建立 MeetingInstance）
② 檢查邀請者的 activeBotCount < max_concurrent_bots → 否則 409
   activeBotCount = 此使用者 status = 'ACTIVE' 的 MeetingInstance 數量
   （注意：PENDING 競態由步驟④的 Vexa 403 處理，見下方說明）
③ Prisma create MeetingInstance（status: PENDING）
④ 呼叫 Vexa POST /bots（使用邀請者的 vexaToken，需帶 voice_agent_enabled: true、bot_name: "蜜塔"）
   ↳ 成功 → 取得 vexaMeetingId（整數），暫存但**不更新** DB 狀態
   ↳ Vexa 403「User has reached the maximum concurrent bot limit」（並發競態）
     → 刪除步驟③剛建立的 PENDING MeetingInstance（rollback，不留 zombie）
     → 回傳 409 BOT_CONCURRENT_LIMIT
     ⚠️ 此路徑發生於：步驟③到步驟⑤ DB 更新的數秒窗口內，另一個請求的 Bot
        已被 Vexa 計入 REQUESTED/JOINING/AWAITING_ADMISSION（尚未反映在 app ACTIVE 計數），
        導致步驟②放行但步驟④被 Vexa 擋下
   ↳ 其他錯誤（網路、逾時等） → 保留 PENDING 狀態，UI 顯示重試按鈕；終止後續步驟
⑤ 啟動後端 MeetingSession（訂閱 Vexa /ws 的三條 channel + 喚醒詞監聽）
   ↳ 成功 → 更新 DB：vexaMeetingId、vexaNativeMeetingId（= nativeMeetingId）、
             creatorApiTokenId（= 當前 vexaToken 在 public.api_tokens 中的 id）；
             **DB 維持 PENDING 狀態，不在此時設 ACTIVE**
             ⚠️ Vexa Bot 需歷經 joining → awaiting_admission → active 各階段
                若提前設 ACTIVE，在 Vexa meeting.status ≠ "active" 期間呼叫 /speak 或 /chat
                會因 Vexa _find_active_meeting 回傳 404 而失敗
                DB 轉 ACTIVE 由 MeetingSession 的 WS 訊息處理器負責，
                待收到 {type: "meeting.status", payload: {status: "active"}} 後自動更新
                （同時記錄 startedAt = now()）
   ↳ 失敗（WS 無法連線）→ 呼叫 Vexa DELETE /bots/{platform}/{nativeMeetingId} 撤銷 Bot；
               DB 保留 PENDING 狀態，UI 下次輪詢見 PENDING 可顯示重試提示
（歡迎訊息不在此流程發送。Vexa 的 /chat 要求 meeting.status == "active"；
 Bot 此時仍處於 joining/awaiting_admission 階段，立即呼叫 /chat 會回 404。
 歡迎訊息由 MeetingSession 的 WS handler 在收到
 {type: "meeting.status", payload: {status: "active"}} 時非同步發送，
 詳見 06-後端架構.md § handleBotStatusChange。）
```

> **`voice_agent_enabled: true` 說明**：此旗標讓 Vexa 為該 Bot 啟用語音功能（`/speak`、`/chat` endpoint）。
> 若建立 Bot 時未帶此旗標，TTS 語音回覆與聊天室傳訊將無法使用。
>
> **`bot_name: "蜜塔"` 說明**：Bot 在 Google Meet 中顯示的暱稱。若省略，Vexa 預設使用 `VexaBot-{6位隨機碼}`，
> 與會者將看不到「蜜塔」這個名字。

**Error cases**
```json
// 403：Token scope 不足（缺少 bot、browser 或 tx scope）
{
  "error_code": "INSUFFICIENT_SCOPE",
  "message": "此 token 缺少邀請 Bot 所需的 scope（需要 bot、browser、tx）",
  "details": { "required": ["bot", "browser", "tx"], "actual": ["tx"] }
}

// 409：Bot 並發上限（步驟②的 app 計數，或步驟④的 Vexa 403 競態）
{
  "error_code": "BOT_CONCURRENT_LIMIT",
  "message": "您目前已有 1 個進行中的 Bot，無法再建立",
  "details": { "maxConcurrentBots": 1, "activeBotCount": 1 }
}
```

---

### `GET /projects/:projectId/meetings`

取得專案的會議清單。**需要：檢視權**。

**Query Params**

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` | 1 | |
| `per_page` | 20 | |
| `search` | — | 依會議名稱搜尋 |
| `since` | — | 篩選最近 N 天內（`1` / `3` / `7`） |
| `order` | `desc` | 排序方向（`asc` / `desc`，依 `created_at`） |
| `status` | — | 篩選（`PENDING` / `ACTIVE` / `ENDED` / `FAILED`） |

**Response 200**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "每週同步會議",
      "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
      "status": "ACTIVE",
      "startedAt": "2026-05-26T10:05:00Z",
      "endedAt": null,
      "createdAt": "2026-05-26T10:00:00Z"
    },
    {
      "id": "uuid",
      "name": "產品需求討論",
      "status": "ENDED",
      "startedAt": "2026-05-25T14:00:00Z",
      "endedAt": "2026-05-25T15:30:00Z",
      "createdAt": "2026-05-25T13:55:00Z"
    }
  ],
  "total": 10,
  "page": 1,
  "perPage": 20
}
```

---

### `GET /projects/:projectId/meetings/:meetingId`

取得會議詳細資訊。**需要：檢視權**。

**Response 200**
```json
{
  "id": "uuid",
  "name": "每週同步會議",
  "googleMeetUrl": "https://meet.google.com/abc-defg-hij",
  "status": "ENDED",
  "vexaMeetingId": 456,
  "createdBy": {
    "vexaUserId": 123,
    "name": "User Name"
  },
  "startedAt": "2026-05-26T10:05:00Z",
  "endedAt": "2026-05-26T11:00:00Z",
  "summary": "本次會議討論了 Q3 產品路線圖，確認了三個主要功能的優先順序...",
  "actionItems": [
    {"task": "完成 API 設計文件", "owner": "User A"},
    {"task": "安排與設計師的 wireframe review", "owner": "User B"},
    {"task": "確認技術方案可行性", "owner": ""}
  ],
  "createdAt": "2026-05-26T10:00:00Z",
  "updatedAt": "2026-05-26T11:05:00Z"
}
```

---

### `PATCH /projects/:projectId/meetings/:meetingId`

更新會議名稱。**需要：會議權（Owner 或被授予 `canMeeting` 的參與者）**。

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

### `POST /projects/:projectId/meetings/:meetingId/bot/leave`

讓 Bot 離開會議。**需要：會議權（Owner 或被授予 `canMeeting` 的參與者）**。
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
① 查詢 meeting.creatorApiTokenId → raw query 取得 vexaToken 字串
   呼叫 Vexa DELETE /bots/{platform}/{vexaNativeMeetingId}（Header: X-API-Key: vexaToken）
   （platform 固定為 "google_meet"；vexaNativeMeetingId 來自 meeting_instances 欄位）
   ⚠️ 若 token 已過期（查無結果）：跳過 DELETE /bots 呼叫，記 warn log；
      Bot 仍留在 Google Meet 並佔用配額，直到 Vexa-lite 超時自動終止。
      仍繼續執行步驟②，確保 meetbot DB 正確更新為 ENDED。
      使用者若遇到「Bot 上限」可透過 Vexa Dashboard 手動清除殘留 Bot。
② 呼叫 handleSessionClose(meetingInstanceId)——步驟②③④ 由此函式原子執行：
   ⚠️ 不可將②③④拆開逐步執行：handleSessionClose 在首行即刪除 Map entry（原子鎖），
   確保 Vexa WS 同時發出的 meeting.status:completed 事件不會觸發第二次摘要生成。
   （詳見 06-後端架構.md § handleSessionClose）
② 更新 MeetingInstance：status: ENDED、endedAt = now()
③ 關閉此會議的 MeetingSession（取消訂閱 Vexa /ws channel）
④ 觸發摘要工作流（非同步，回應 200 後在背景執行）
   ↳ 呼叫 Vexa REST API GET /transcripts/{platform}/{vexaNativeMeetingId}，取得全量逐字稿
   ↳ 格式化為 Markdown（含說話者標記與時間戳，格式見 06-後端架構.md § 6）
   ↳ 儲存至 Supabase Storage（路徑：transcripts/{meetingInstanceId}/transcript.md）
   ↳ 透過 Dify Files API（POST /files/upload）上傳 MD 檔（使用 DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY）→ 取得 upload_file_id
   ↳ 呼叫 Dify 會議摘要 Workflow（POST /workflows/run，MEETING_SUMMARY_WORKFLOW_API_KEY，inputs.transcript 以 file 物件傳入）
   ↳ 解析 data.outputs.result_json → 取得 meeting_title、summary、key_topics、decisions、action_items（格式：[{task, owner}]）
   ↳ 更新 MeetingInstance.summary + actionItems + transcriptStoragePath
```

> **注意**：Vexa 的 Bot 控制 API 以 `{platform}/{nativeMeetingId}` 作路由參數，
> 而非使用 Vexa 回傳的整數 `meeting_id`（後者僅用於查詢 transcriptions）。
> 因此 `meeting_instances` 需同時儲存兩個 ID。

---

### `GET /projects/:projectId/meetings/:meetingId/transcriptions`

取得會議逐字稿。**需要：檢視權**。

> **實作注意（統一透過 Vexa REST API 取得）**：
>
> 無論 ACTIVE 或 ENDED，均呼叫：
> `GET /transcripts/{platform}/{vexaNativeMeetingId}`（Header: `X-API-Key: <inviterVexaToken>`）
>
> ⚠️ **`inviterVexaToken` 取得方式（依會議狀態不同）**：
>
> Vexa 的 `GET /transcripts` 以 `Meeting.user_id == current_user.id` 做授權（見 `collector/endpoints.py:319-323`）。
> 因此必須使用**邀請者的 token**，而非發出此次 HTTP 請求的使用者 token（參與者可能不同人）。
>
> | 會議狀態 | 取法 |
> |----------|------|
> | **ACTIVE** | `activeSessions.get(meetingInstanceId)?.creatorVexaToken`（記憶體直取） |
> | **ENDED / FAILED** | Session 已清除，需查 DB：`SELECT token FROM public.api_tokens WHERE id = meeting.creatorApiTokenId AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1` |
>
> 若查詢結果為空（token 已過期或不存在），回傳 `503 SERVICE_UNAVAILABLE`（非 404，避免誤導為「無逐字稿」）。
> 具體實作見 `06-後端架構.md § 五之一`。
>
> Vexa 內部已處理 Redis（熱段落）與 Postgres（已落盤段落）的合併，
> meetbot backend 無需直接存取 Redis 或 `public.transcriptions`。
>
> - **增量 cursor**：backend 從 Vexa 取全量後，以 `since_start_time`（float，秒）在記憶體過濾後回傳
> - **ENDED 會議**：逐字稿靜態，前端一次性取完即可；可搭配 `page`/`per_page` 分頁
> - **ACTIVE 會議**：前端以 3 秒輪詢 `?since_start_time=<last_end_time>` 取得新 segments
>
> ⚠️ `since_id` 參數已移除（Vexa REST API 不暴露整數 `id`，見 `schemas.py TranscriptionSegment`）
>
> ⚠️ **O(n) 陷阱（ACTIVE 輪詢）**：Vexa REST API 不支援 server-side `since_start_time` 過濾——
> backend 每次輪詢都取回**全量**逐字稿，再在記憶體以 `since_start_time` 裁切。
> 對於長會議（例如 2 小時，約 2000+ segments），每 3 秒的輪詢會傳輸大量重複資料。
>
> **緩解措施（MVP 可接受，建議未來改善）**：
> 1. Vexa /ws `tc:meeting:{id}:mutable` channel 已在 `MeetingSession` 中即時接收 segments；
>    若未來需要低延遲即時顯示，可改為讓前端訂閱後端 SSE，後端從 WS 推送，不需輪詢全量。
> 2. 若僅需解決重複傳輸問題，可在 meetbot backend 快取最後一次回傳的 `endTime`，
>    僅對 Vexa 的回應做 in-memory slice 後回傳差異；不需修改 Vexa。

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
| `POST /meetings`（全局建立） | ✅ | ✅ | ✅ | ✅ | ✅（projectId 留空時）|
| `GET /meetings`（全局列表） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /meetings/:mid`（全局存取） | ✅ | ✅ | ✅ | ✅ | ✅（建立者）|
| `PATCH /meetings/:mid`（全局改名） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `POST /meetings/:mid/bot/leave`（全局停止） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `GET /meetings/:mid/transcriptions`（全局逐字稿） | —¹ | —¹ | —¹ | —¹ | ✅（建立者）|
| `GET /projects` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /projects` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /projects/:id` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `PATCH /projects/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `DELETE /projects/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET .../members` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `POST .../members` | ✅ | ❌ | ❌ | ❌ | ❌ |
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

> ¹ **全局無關聯專案端點**（`PATCH /meetings/:mid`、`POST /meetings/:mid/bot/leave`、`GET /meetings/:mid/transcriptions`）：
> 授權邏輯為 `vexaUserId === meeting.createdByVexaUserId`（**建立者本人**），不涉及專案成員權限。
>
> ² **會議操作（建立、改名、結束）需要 `canMeeting`**：
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

- **觸發**：Bot 離開會議（`POST .../bot/leave` 或 Vexa 偵測到 Bot 掉線）
- **邏輯**：呼叫 Vexa REST API 取全量逐字稿 → 格式化為 Markdown → 存至 Supabase Storage → 上傳 MD 檔至 Dify Files API → 呼叫 Dify 摘要工作流（以 file 傳入）生成摘要與交辦事項 → 更新 MeetingInstance
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

## 十三、環境變數（API 相關）

```bash
# Hono server
APP_PORT=4000
APP_CORS_ORIGINS="http://localhost:3000"

# Dify（四把獨立 API Key，分別對應不同用途；完整說明見 01-RAG_API_串接文件_v1.1.md）
DIFY_API_BASE="https://api.dify.ai/v1"
DIFY_DATASET_API_KEY="dataset-..."              # Knowledge Base 操作（上傳/刪除文件、查詢索引狀態）
DIFY_WORKFLOW_API_KEY="app-..."                 # RAG Q&A Chatflow（/chat-messages）
DIFY_SUMMARY_WORKFLOW_API_KEY="app-..."         # 檔案摘要 Workflow（/workflows/run，上傳後預覽）
DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY="app-..." # 會議摘要 Workflow（/workflows/run，會議結束後觸發）
DIFY_CHATFLOW_TIMEOUT_MS=45000                  # Q&A Chatflow 逾時（ms）；預設 45 秒

# Claude（Anthropic）
ANTHROPIC_API_KEY="sk-ant-..."       # 無知識庫會議的逐字稿 Q&A 專用（answerFromTranscript 路徑）
                                     # 摘要已改為透過 Dify 工作流處理（以 MD 檔傳入），不再直接呼叫 Claude
```

> `NEXTAUTH_SECRET` 僅前端（Next.js）使用，後端不需要。
> 後端認證改由查詢 `public.api_tokens` 驗證 vexaToken，詳見第一節。

---

*文件結尾*
