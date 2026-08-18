# 資料庫 Schema 設計

> 🟢 **活文件**：須與目前程式碼同步，可當現行規格參考。若與程式不符，以程式為準並回寫本文件。最後對齊：2026-06-04。

|項目|內容|
|----|-----|
|文件版本|v1.8|
|撰寫日期|2026-06-04|
|依據文件|`01-專案目標.md`、`02-使用者需求.md`|
|ORM|Prisma（multiSchema）|
|資料庫|Supabase PostgreSQL|

---

## 一、總體設計原則

### 1.1 雙層 Schema 隔離

> ⚠️ **2026-08 起不再有雙 schema。** 身份層（使用者與 API token）原本寄生在 Vexa 的
> `public.users` / `public.api_tokens`，移除 Vexa 之後整套搬進 `app` schema 自管。
> 現在**只有 `app` 一個 schema**，也不再有任何 `public.*` 的 `$queryRaw`。

```
PostgreSQL
└── schema: app             ← 應用獨立管理（Prisma db push）
    ├── users                  ← 使用者（email / name / max_concurrent_bots）
    ├── user_tokens            ← API token（Bearer 驗證的來源）
    ├── projects
    ├── project_members
    ├── project_invitations    ← 待處理的專案邀請（可邀請尚未註冊者）
    ├── materials
    ├── material_edit_history
    ├── activity_logs          ← 通用活動紀錄（成員/權限/會議/改名等）
    └── meeting_instances
```

> `datasource.schemas` 只宣告 `["app"]`（見 §二）。Vexa 時代留在 `public` 的舊表
> （users / meetings / transcriptions / api_tokens）程式已完全不碰，db push 也不會動到它們；
> 留著是為了保存歷史資料，確認不需要後可自行 `DROP SCHEMA public CASCADE`。

### 1.2 使用者關聯鍵

- 使用者以 `app.users.id`（Integer）關聯，欄位名沿用 `*_vexa_user_id`（見下方 `@map`）：
  **只是沒有改欄位名，語意已經是 app 自己的 user id**。改名要改 8 張表的欄位，
  沒有相應好處，還會讓既有資料需要一次 migration。
- Prisma model 上的欄位名已一律改成 `ownerUserId` / `userId` / `createdByUserId` …，
  程式碼裡不再出現 `vexa` 字樣；`@map` 負責對應到 DB 的實體欄位名。
- 各關聯表**不建立**指向 `users` 的 FK 約束（沿用原本的邏輯 FK 策略，刪使用者不連鎖爆炸）。

> **既有資料遷移**：`app.users` 的 id 必須沿用 Vexa `public.users.id`，否則所有
> `*_user_id` 會指到錯的人。遷移 SQL 見 `backend/scripts/sql/02-post-db-push.sql`
> （`start.ps1` 會自動跑，冪等）。

### 1.3 Soft Delete 策略

- `projects`、`materials` 採 soft delete（`deleted_at` 欄位）
- `meeting_instances` **不可刪除**（無 `deleted_at`），保護歷史逐字稿
- `project_members` 採硬刪除（移除成員＝`prisma.projectMember.delete`，同時寫 `activity_logs` 審計）；
  `material_edit_history`、`activity_logs` 為純追加的審計紀錄，不刪除
- `project_invitations` 不刪除：撤銷/拒絕/過期皆以 `status` 欄位轉換（REVOKED / DECLINED / EXPIRED）保留紀錄
- `meeting_instances.project_id` 為 **nullable**：使用者可建立不關聯任何專案的獨立會議實例（無 Dify Knowledge Base，Q&A 功能停用，但逐字稿與摘要功能正常）

---

## 二、`app` Schema — Prisma 完整定義

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")  // 連線字串需加 ?schema=app
  directUrl = env("DIRECT_URL")   // Prisma CLI（db push / db execute）走 session pooler
  schemas  = ["app"]
}

// ══════════════════════════════════════════════════
// app schema：應用核心業務邏輯
// ══════════════════════════════════════════════════

/// 使用者（2026-08 從 Vexa public.users 搬進來，id 沿用原值）
model User {
  id                Int         @id @default(autoincrement())
  /// Google 登入的已驗證 email，全站唯一
  email             String      @unique
  /// Google 顯示名稱，可能為 null（前端 displayName() 會退回 email 前段）
  name              String?
  /// 同時可派出的 bot 數上限（GET /me 與建立會議前的並發檢查）
  maxConcurrentBots Int         @default(1) @map("max_concurrent_bots")
  createdAt         DateTime    @default(now()) @map("created_at")
  tokens            UserToken[]

  @@map("users")
  @@schema("app")
}

/// API token（Authorization: Bearer 的驗證來源）
/// 由 POST /internal/token 於 NextAuth 登入時 get-or-create，前端存在 session 裡。
model UserToken {
  id        Int       @id @default(autoincrement())
  token     String    @unique
  userId    Int       @map("user_id")
  user      User      @relation(fields: [userId], references: [id])
  /// null = 永不過期（目前登入流程一律不設期限）
  expiresAt DateTime? @map("expires_at")
  createdAt DateTime  @default(now()) @map("created_at")

  @@map("user_tokens")
  @@schema("app")
}

/// 專案實例
model Project {
  id              String    @id @default(uuid())
  name            String
  /// 所有者 ID，邏輯關聯 public.users.id（無 FK 約束）
  ownerUserId Int       @map("owner_vexa_user_id")
  /// 對應此專案的 Dify Knowledge Base ID（建立專案時同步建立）
  difyDatasetId   String    @map("dify_dataset_id")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  /// Soft delete：所有者刪除專案時設定
  deletedAt       DateTime? @map("deleted_at")

  members          ProjectMember[]
  invitations      ProjectInvitation[]
  materials        Material[]
  editHistory      MaterialEditHistory[]
  activityLogs     ActivityLog[]
  meetingInstances MeetingInstance[]

  @@index([ownerUserId])
  @@index([deletedAt])
  @@map("projects")
  @@schema("app")
}

/// 專案參與者（不包含所有者，所有者由 projects.owner_vexa_user_id 記錄）
model ProjectMember {
  id                  String   @id @default(uuid())
  projectId           String   @map("project_id")
  /// 參與者 ID，邏輯關聯 public.users.id
  userId          Int      @map("vexa_user_id")
  /// 檢視權＝成員「基準權限」：恆為 true、不可取消（要移除存取請用 removeMember）。
  /// 內容：查看資料清單、歷史紀錄、成員清單、會議逐字稿。
  /// 應用層在 updateMemberPermissions 會把任何 canView=false 的請求強制矯正回 true。
  canView             Boolean  @default(true) @map("can_view")
  /// 編輯權：上傳 / 刪除資料檔案（基準權限之上的加購能力）
  canEdit             Boolean  @default(false) @map("can_edit")
  /// 會議權：建立會議實例、邀請/移除 Bot、更新會議名稱（預設 false，由所有者授權）
  canMeeting          Boolean  @default(false) @map("can_meeting")
  /// 邀請人 ID，邏輯關聯 public.users.id（目前只有所有者可邀請）
  invitedByUserId Int      @map("invited_by_vexa_user_id")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId], references: [id])

  /// 同一使用者在同一專案只能有一筆參與者紀錄
  @@unique([projectId, userId])
  @@index([userId])
  @@map("project_members")
  @@schema("app")
}

/// 待處理的專案邀請。可邀請尚未在系統建立帳號的人（以 email 為依據）。
/// 對方登入後，後端以「已驗證的 Google email」比對 PENDING 邀請，於其信箱列出供接受。
/// token 僅存 SHA-256 hash；接受時強制 email 比對，避免連結外洩被冒領。
model ProjectInvitation {
  id                   String           @id @default(uuid())
  projectId            String           @map("project_id")
  email                String // 一律正規化為小寫儲存
  tokenHash            String           @unique @map("token_hash") // token 的 SHA-256（不存明碼）
  /// 檢視權為基準權限，建立邀請時恆為 true（與 ProjectMember 一致）
  canView              Boolean          @default(true) @map("can_view")
  canEdit              Boolean          @default(false) @map("can_edit")
  canMeeting           Boolean          @default(false) @map("can_meeting")
  status               InvitationStatus @default(PENDING)
  invitedByUserId  Int              @map("invited_by_vexa_user_id")
  acceptedByUserId Int?             @map("accepted_by_vexa_user_id")
  expiresAt            DateTime         @map("expires_at")
  acceptedAt           DateTime?        @map("accepted_at")
  createdAt            DateTime         @default(now()) @map("created_at")
  updatedAt            DateTime         @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId], references: [id])

  @@index([email, status])      // 收件者信箱：以登入 email 列出待處理邀請
  @@index([projectId, status])  // 擁有者檢視：列出某專案的待處理邀請
  @@map("project_invitations")
  @@schema("app")
}

/// 專案上傳的資料檔案
model Material {
  id                   String         @id @default(uuid())
  projectId            String         @map("project_id")
  /// 原始檔名（含副檔名）
  filename             String
  /// 顯示名稱（可由使用者自訂，預設同 filename）
  displayName          String         @map("display_name")
  sizeBytes            BigInt         @map("size_bytes")
  mimeType             String         @map("mime_type")
  /// SHA-256 用於判重，同一專案內不允許重複上傳相同檔案
  sha256               String
  /// Supabase Storage 的完整路徑（格式：{projectId}/{uuid}/{filename}）
  storagePath          String         @map("storage_path")
  /// Dify 文件 ID（上傳 response 的 document.id，用於刪除文件）
  difyDocumentId       String?        @map("dify_document_id")
  /// Dify batch ID（上傳 response 的 batch，用於輪詢索引狀態）
  /// 對應 GET /datasets/{dataset_id}/documents/{batch}/indexing-status
  difyBatch            String?        @map("dify_batch")
  /// Dify 索引狀態（非同步，透過 background job 輪詢更新）
  indexingStatus       IndexingStatus @default(PENDING) @map("indexing_status")
  /// 索引失敗時的錯誤訊息
  indexingError        String?        @map("indexing_error")
  /// 上傳者 ID，邏輯關聯 public.users.id
  uploadedByUserId Int            @map("uploaded_by_vexa_user_id")
  uploadedAt           DateTime       @default(now()) @map("uploaded_at")
  updatedAt            DateTime       @updatedAt @map("updated_at")
  /// Soft delete：刪除時設定，同步刪除 Storage 和 Dify 文件
  deletedAt            DateTime?      @map("deleted_at")

  project     Project               @relation(fields: [projectId], references: [id])
  editHistory MaterialEditHistory[]

  /// 同一專案內同一檔案（sha256）只能存在一筆有效紀錄
  /// 注意：判重時需排除已 soft delete 的紀錄（應用層處理）
  @@unique([projectId, sha256])
  @@index([projectId, uploadedAt(sort: Desc)])
  @@index([indexingStatus])
  @@map("materials")
  @@schema("app")
}

/// 資料操作的唯讀歷史紀錄（上傳 / 刪除）
model MaterialEditHistory {
  id                    String     @id @default(uuid())
  projectId             String     @map("project_id")
  materialId            String     @map("material_id")
  action                EditAction
  /// 操作當下的檔名快照（避免日後 material 資料變動導致歷史失真）
  filenameSnapshot      String     @map("filename_snapshot")
  /// 操作者 ID，邏輯關聯 public.users.id
  performedByUserId Int        @map("performed_by_vexa_user_id")
  performedAt           DateTime   @default(now()) @map("performed_at")

  project  Project  @relation(fields: [projectId], references: [id])
  material Material @relation(fields: [materialId], references: [id])

  @@index([projectId, performedAt(sort: Desc)])
  @@index([materialId])
  @@map("material_edit_history")
  @@schema("app")
}

/// 通用活動紀錄：素材增刪、成員邀請/增減、權限變更、會議建立、專案改名等。
/// 與 MaterialEditHistory 不同，本表不綁定特定 materialId，可記錄任意專案層級事件。
/// 純追加（append-only），由 activity.service.ts 的 recordActivity 寫入。
model ActivityLog {
  id              String         @id @default(uuid())
  projectId       String         @map("project_id")
  actorUserId Int            @map("actor_vexa_user_id")
  action          ActivityAction
  /// 事件對象的快照字串（檔名 / 成員 email / 會議名稱），避免日後關聯變動導致歷史失真
  targetLabel     String         @map("target_label")
  metadata        Json?
  createdAt       DateTime       @default(now()) @map("created_at")

  project Project @relation(fields: [projectId], references: [id])

  @@index([projectId, createdAt(sort: Desc)])
  @@map("activity_logs")
  @@schema("app")
}

/// 會議實例（不可刪除，保護歷史逐字稿）
model MeetingInstance {
  id                   String        @id @default(uuid())
  /// 關聯的專案（可為 null：使用者選擇不關聯任何專案時建立獨立會議實例）
  /// null 時 Bot 仍可提供逐字稿與摘要，但 Dify Q&A 功能停用（無 Knowledge Base）
  projectId            String?       @map("project_id")
  /// Google Meet 的 native meeting id（例如 "abc-defg-hij"）
  /// 由 googleMeetUrl 解析取得；在 Bot 成功加入前為 null
  nativeMeetingId      String?       @map("vexa_native_meeting_id")
  /// 會議名稱（可自訂，預設由系統生成，例如「會議 2026-05-26 14:30」）
  name                 String
  /// Google Meet URL（使用者輸入或從 meet.new 取得）
  googleMeetUrl        String        @map("google_meet_url")
  status               MeetingStatus @default(PENDING)
  /// 邀請 Bot 的使用者 ID（邏輯關聯 app.users.id）
  createdByUserId      Int           @map("created_by_vexa_user_id")
  /// 會議實際開始時間（Bot 成功加入後記錄）
  startedAt            DateTime?     @map("started_at")
  /// 會議結束時間（Bot 離開後記錄）
  endedAt              DateTime?     @map("ended_at")
  /// Dify 總結工作流生成的會議摘要（會議結束後填入）
  summary              String?
  /// Dify 提取的交辦事項（JSONB 陣列，會議結束後填入）
  /// 格式：[{"task": "事項描述", "owner": "負責人（可空字串）"}]
  /// （依據 01-RAG v1.1：action_items 每筆含 task + owner 兩欄）
  actionItems          Json?         @map("action_items")
  /// Dify 提取的關鍵議題（JSONB 字串陣列，會議結束後填入，供未來查閱）
  /// 格式：["議題一", "議題二", ...]（依據 01-RAG v1.1：key_topics 為字串陣列）
  keyTopics            Json?         @map("key_topics")
  /// Dify 提取的決議事項（JSONB 字串陣列，會議結束後填入，供未來查閱）
  /// 格式：["決議一", "決議二", ...]（依據 01-RAG v1.1：decisions 為字串陣列）
  decisions            Json?         @map("decisions")
  /// 逐字稿 Markdown 檔的 Storage 路徑（摘要流程寫入）
  /// 路徑格式：transcripts/{meetingInstanceId}/transcript.md
  /// Bucket：SUPABASE_STORAGE_BUCKET（與 meeting-materials 共用，以路徑前綴區隔）
  transcriptStoragePath String?      @map("transcript_storage_path")
  createdAt            DateTime      @default(now()) @map("created_at")
  updatedAt            DateTime      @updatedAt @map("updated_at")

  /// projectId 為 nullable，關聯設為可選
  project Project? @relation(fields: [projectId], references: [id])

  @@index([projectId, createdAt(sort: Desc)])   // 專案會議清單分頁（projectId IS NOT NULL 查詢）
  @@index([createdByUserId, createdAt(sort: Desc)])  // 全局 Meetings 頁面分頁（跨專案 + 無專案）
  @@index([status])
  @@index([createdByUserId, status])   // activeBotCount 查詢（GET /me 及建立會議前並發檢查）
  @@map("meeting_instances")
  @@schema("app")
}

// ── Enums ──────────────────────────────────────────

enum IndexingStatus {
  PENDING    // 剛上傳，尚未開始索引
  PROCESSING // Dify 正在建立索引
  COMPLETED  // 索引完成，可用於 RAG 查詢
  FAILED     // 索引失敗，見 indexingError

  @@map("indexing_status")
  @@schema("app")
}

enum EditAction {
  UPLOAD // 上傳資料檔案
  DELETE // 刪除資料檔案

  @@map("edit_action")
  @@schema("app")
}

enum InvitationStatus {
  PENDING  // 已建立，等待對方接受
  ACCEPTED // 對方已接受（同時建立 ProjectMember）
  DECLINED // 對方拒絕
  REVOKED  // 擁有者撤銷
  EXPIRED  // 逾期未接受（接受時若已過期會即時轉此狀態）

  @@map("invitation_status")
  @@schema("app")
}

enum ActivityAction {
  MATERIAL_UPLOAD
  MATERIAL_DELETE
  MEMBER_INVITE            // 建立邀請（pending）
  MEMBER_ADD               // 邀請被接受、成員正式加入
  MEMBER_REMOVE
  MEMBER_PERMISSION_UPDATE
  MEETING_CREATE
  PROJECT_RENAME

  @@map("activity_action")
  @@schema("app")
}

enum MeetingStatus {
  PENDING // 會議實例已建立，Bot 尚未加入（Recall dispatch 進行中）
  ACTIVE  // Bot 已成功加入會議，逐字稿進行中
  ENDED   // 會議已結束（正常）：Bot 主動離開或使用者呼叫 POST /bot/leave
  FAILED  // 異常終止態（但非不可逆）：
          //   - 服務重啟時發現的 zombie PENDING（5 分鐘超時清理）
          //   - Bot 異常終止：provider 回報 bot 結束於 admitted 之前（被踢出或逾時）
          //     → 由 handleSessionClose(id, 'failed') 設定，不觸發摘要工作流
          //   - 使用者主動取消 PENDING（POST .../cancel）也會落入 FAILED
          //   ⚠️ FAILED 與 ENDED 皆不可刪除（保護歷史查詢紀錄）
          //   前端對 FAILED 顯示失敗原因 + 「🔄 重新邀請蜜塔」按鈕（POST .../bot/reinvite，
          //     轉回 PENDING 重試，不需重建會議）
          //   ENDED 同樣可重邀，但因已有摘要/逐字稿等正式資料，reinvite 會**另建新
          //     MeetingInstance**（原紀錄保留不覆寫）並回傳新 id

  @@map("meeting_status")
  @@schema("app")
}

// ══════════════════════════════════════════════════
// public schema：已不再使用（2026-08 移除 Vexa）
// 身份層搬進 app.users / app.user_tokens 之後，程式碼沒有任何一處讀 public.*，
// 也不再有 $queryRaw。舊表留在 DB 只是為了保存歷史資料。
// ══════════════════════════════════════════════════
```

---

## 三、Table 關聯圖

```
app.users
    ├─── app.user_tokens.user_id             ──►  [1:N]（唯一有 FK 約束的一條）
    │
    │ (以下為邏輯關聯，無 FK：欄位名保留 *_vexa_user_id，語意已是 app.users.id)
    ├─── app.projects.owner_vexa_user_id
    ├─── app.project_members.vexa_user_id
    ├─── app.project_members.invited_by_vexa_user_id
    ├─── app.project_invitations.invited_by_vexa_user_id
    ├─── app.project_invitations.accepted_by_vexa_user_id
    ├─── app.materials.uploaded_by_vexa_user_id
    ├─── app.material_edit_history.performed_by_vexa_user_id
    ├─── app.activity_logs.actor_vexa_user_id
    └─── app.meeting_instances.created_by_vexa_user_id

app.projects
    ├─── app.project_members.project_id      ──►  [1:N]
    ├─── app.project_invitations.project_id  ──►  [1:N]
    ├─── app.materials.project_id            ──►  [1:N]
    ├─── app.material_edit_history.project_id ──► [1:N]
    ├─── app.activity_logs.project_id        ──►  [1:N]
    └─── app.meeting_instances.project_id    ──► [1:N, nullable]  // null = 獨立會議（無關聯專案）

app.materials
    └─── app.material_edit_history.material_id ──► [1:N]
```

---

## 四、關鍵設計說明

### 4.1 專案刪除的連鎖行為（應用層處理）

刪除專案（設定 `projects.deleted_at`）時，應用層需同步執行：

```
1. 將所有 materials.deleted_at 設為 now()
2. 對每筆 material 觸發三方清理：
   a. 刪除 Supabase Storage 檔案
   b. 刪除 Dify Knowledge Base 文件
   c. （Prisma record 已 soft delete，不硬刪）
3. 刪除 Dify Knowledge Base（整個 dataset）
4. 設定 projects.deleted_at = now()
5. 保留 project_members（歷史查詢用）
6. 保留 meeting_instances（不可刪除原則）
7. 保留 material_edit_history（審計紀錄）
```

### 4.2 檔案上傳的三方 Rollback

`POST /materials` 涉及三個外部系統，任一步驟失敗需逆序回滾：

```
步驟                              失敗時 rollback
─────────────────────────────────────────────────────
① 驗證（格式、大小、SHA-256 判重）  → 直接 4xx，無需清理
② 上傳 Supabase Storage           → 無需清理（此步驟剛開始）
③ 呼叫 Dify API 建立文件           → ② 刪除 Storage 檔案
④ Prisma create Material 紀錄     → ② 刪除 Storage + ③ 刪除 Dify 文件
⑤ 建立 MaterialEditHistory 紀錄   → 若失敗需補寫（不影響主流程，記錄錯誤日誌）
```

### 4.3 SHA-256 判重的特殊情況

`@@unique([projectId, sha256])` 涵蓋**包含 soft deleted 的所有紀錄**。

因此：若同一檔案曾被上傳後刪除，再次上傳時會觸發 unique constraint 錯誤。

**應用層處理**：在執行 Prisma create 前，先查詢是否存在相同 sha256 的紀錄：

```typescript
const existing = await prisma.material.findFirst({
  where: { projectId, sha256 }
})

if (existing && !existing.deletedAt) {
  throw new DuplicateFileError(existing.id)  // 409
}

if (existing && existing.deletedAt) {
  // 同一檔案曾被刪除，允許重新上傳
  // 策略：建立新紀錄，保留刪除歷史（完整審計軌跡）
  //   步驟 1：對舊紀錄設 sha256 = `DELETED_${existing.id}`（騰出 unique slot）
  //   步驟 2：建立新紀錄（sha256 = 實際雜湊值）
  //
  // ⚠️ sha256 為 String NOT NULL，有以下限制：
  //   - 不可設 null（欄位定義不允許）
  //   - 不可設 ""（多個 soft-deleted 同檔會再次衝突）
  //   - 使用 `DELETED_<uuid>` sentinel：全域唯一、可辨識、不影響判重邏輯
  await prisma.material.update({
    where: { id: existing.id },
    data: { sha256: `DELETED_${existing.id}` },  // 騰出 unique slot
  })
  // 繼續執行 prisma.material.create(...) 建立新紀錄
}
```

> **⚠️ 並發競態（TOCTOU）處理**：兩個請求可能同時通過上方的 `findFirst` 判重，
> 之後都執行 `prisma.material.create`，其中一個會觸發 PostgreSQL unique constraint 違反。
> Prisma 以 `PrismaClientKnownRequestError`（code `P2002`）拋出，必須明確捕捉並回傳 409，
> 否則未處理的 DB 錯誤會變成 500：
>
> ```typescript
> try {
>   await prisma.material.create({ data: { ... } })
> } catch (err) {
>   if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
>     throw new DuplicateFileError()   // → 409 DUPLICATE_FILE
>   }
>   throw err
> }
> ```

```typescript
```

### 4.4 MeetingInstance 的 nativeMeetingId 為何可為 null

建立會議實例時要先請 provider（Recall）派 bot 進 Google Meet，這是非同步且可能失敗的。因此：

- **建立中**（`status = PENDING`）：`nativeMeetingId = null`
- **成功加入**（`status = ACTIVE`）：`nativeMeetingId` = 由 `googleMeetUrl` 解析出的
  Meet code（例如 `abc-defg-hij`）
- **加入失敗**：轉為 `FAILED`，UI 顯示重新邀請選項

> **provider 端的 bot id 不落 DB。** Vexa 時代還有一個 `vexa_meeting_id`（整數）用來查逐字稿，
> Recall 用的是字串 bot id，且逐字稿走 webhook 推送、活在記憶體裡，沒有「用 id 回頭查」這條路，
> 所以該欄位隨 Vexa 一併刪除。代價是重啟後接不回進行中的會議（見 13 §已知限制）。

> **無關聯專案的會議**：建立時 `projectId = null`，`MeetingSession.difyDatasetId = null`。
> Bot Session 中 `dispatchQuestion` 收到喚醒詞後，若 `difyDatasetId` 為 null，
> 以最近 30 段逐字稿作為 context，透過 Claude（`claude-sonnet-4-6`）直接回答；不呼叫 Dify Chatflow。

### 4.5 Dify Dataset 與專案的關係

- 每個專案建立時，**同步**呼叫 Dify API 建立一個專屬的 Knowledge Base（dataset）
- `projects.dify_dataset_id` 存儲此 dataset ID
- 所有屬於該專案的 `materials` 都上傳到同一個 dataset
- 會議中的 Q&A 查詢透過 `meeting_instances → project → dify_dataset_id` 決定要查哪個 dataset

```
建立專案流程：
① 呼叫 Dify API 建立 dataset → 取得 dify_dataset_id
② Prisma create Project（含 dify_dataset_id）
若 ① 失敗 → 直接 5xx（無需清理）
若 ② 失敗 → 呼叫 Dify API 刪除 dataset（rollback）
```

### 4.6 Bot Session 的上下文隔離（後端設計備註）

後端需對每個 `ACTIVE` 的 `MeetingInstance` 維護一個獨立的 session 物件：

```typescript
interface MeetingSession {
  meetingInstanceId: string         // app.meeting_instances.id
  platform: string                  // 固定為 "google_meet"
  nativeMeetingId: string           // Google Meet code，例如 "abc-defg-hij"
  difyDatasetId: string | null      // 決定查詢哪個 Knowledge Base（null = 無關聯專案，Q&A 功能停用）
  botSession: BotSession | null     // provider 端的 session（Recall bot id + live stream + adapter）
                                    // 說話/發聊天室/取逐字稿全部委派給 botSession.adapter
  isSpeaking: boolean               // 防語音重疊（TTS 播放中時為 true）
  lastWakeAt: number                // 防重複觸發的 timestamp（ms）
  processedSegmentIds: Set<string>  // 已處理過的 segmentId，防止喚醒詞重複觸發
  difyConversationId: string | null // Dify 多輪對話 ID（null = 下次重開新對話）
                                    // 超過 5 分鐘未問問題後自動重置，避免 conversation 過期或過長
  lastQuestionAt: number            // 上次問問題的 timestamp（ms），用於閒置重置計算
}

// session 儲存在後端記憶體（Map），不需要持久化到資料庫
const activeSessions = new Map<string, MeetingSession>()
// key: meetingInstanceId
```

> **`platform` 與 `nativeMeetingId` 的來源**：
> 建立 `MeetingInstance` 時，`googleMeetUrl`（例如 `https://meet.google.com/abc-defg-hij`）
> 可解析出 `platform = "google_meet"` 與 `nativeMeetingId = "abc-defg-hij"`，
> 並存入 `meeting_instances.vexa_native_meeting_id` 欄位（Prisma 上叫 `nativeMeetingId`）。
>
> ⚠️ session 本身**無法**在重啟後恢復：`botSession` 是活的連線與記憶體緩衝，
> 進程一死就沒了。啟動時一律把殘留的 ACTIVE 會議收尾成 ENDED（見 13 §已知限制）。

### 4.7 成員邀請生命週期（`project_invitations`）

邀請改為「**先建 pending 邀請、再由對方接受**」，可邀請**尚未註冊**的人：

```
擁有者輸入 email（POST /projects/:id/members）
  → 正規化小寫；既有帳號才檢查 SELF_INVITE / ALREADY_MEMBER；同專案同 email 已 PENDING → ALREADY_INVITED
  → 產生 token（回傳明碼一次）+ tokenHash（SHA-256 存 DB），status=PENDING，寄出邀請信
  → 寫 activity_logs（MEMBER_INVITE）

對方登入後
  - 站內信箱：以「已驗證 email」比對 PENDING 且未過期的邀請（GET /me/invitations）
  - email 連結落地頁：以 token 接受（accept-by-token）
  → 接受時強制 invitation.email === 登入 email（否則 EMAIL_MISMATCH）
  → $transaction：建立 ProjectMember（沿用邀請的 canView/canEdit/canMeeting）+ status=ACCEPTED
  → 寫 activity_logs（MEMBER_ADD）；冪等：已接受/已是成員直接回成功
```

- **token 安全**：DB 只存 `tokenHash`（SHA-256），明碼 token 僅在建立/重寄當下回傳一次（供未設定 SMTP 時手動轉交）。
- **過期**：`expiresAt = now + INVITATION_TTL_DAYS`；接受時若已過期，即時把 status 轉 `EXPIRED` 並回 `INVITATION_EXPIRED`。
- **撤銷/重寄**：撤銷把 status 轉 `REVOKED`；重寄重新產 token、刷新 `expiresAt`、再寄一次（僅限 PENDING）。
- **canView 基準權限**：建立邀請與調整成員權限時，`canView` 一律強制為 `true`（基準權限），`canEdit`/`canMeeting` 為其上的加購開關。要移除存取請刪除成員，而非取消 canView。

> **與「不直接存 email」原則的關係**：成員紀錄（`project_members`）仍只存 `vexa_user_id`；
> 但邀請的受邀者**可能尚無帳號**，登入後必須靠 email 比對才找得到邀請，因此 `project_invitations` **必須存 email**。
> 這是功能必需（覆蓋 02 早期「後端不直接存 email」的敘述，見 02-使用者需求.md §1.1）。

---

## 五、索引設計總覽

| 資料表 | 索引欄位 | 用途 |
|--------|---------|------|
| `users` | `email` UNIQUE | 登入時 get-or-create、成員查詢 |
| `user_tokens` | `token` UNIQUE | 每個 API request 的 Bearer 驗證（熱路徑） |
| `projects` | `owner_vexa_user_id` | 查詢某使用者擁有的所有專案 |
| `projects` | `deleted_at` | 過濾已刪除的專案 |
| `project_members` | `(project_id, vexa_user_id)` UNIQUE | 防重複加入 + 查詢成員 |
| `project_members` | `vexa_user_id` | 查詢某使用者參與的所有專案 |
| `project_invitations` | `token_hash` UNIQUE | 以 token（hash）接受邀請（連結落地頁） |
| `project_invitations` | `(email, status)` | 收件者信箱：以登入 email 列出 PENDING 邀請 |
| `project_invitations` | `(project_id, status)` | 擁有者檢視：列出某專案的 PENDING 邀請 |
| `activity_logs` | `(project_id, created_at DESC)` | 專案活動紀錄分頁 |
| `materials` | `(project_id, sha256)` UNIQUE | 判重 |
| `materials` | `(project_id, uploaded_at DESC)` | 專案資料清單分頁 |
| `materials` | `indexing_status` | Background job 輪詢 PROCESSING 狀態 |
| `material_edit_history` | `(project_id, performed_at DESC)` | 專案歷史紀錄分頁 |
| `material_edit_history` | `material_id` | 單一檔案的操作歷史 |
| `meeting_instances` | `(project_id, created_at DESC)` | 專案會議清單分頁（project_id IS NOT NULL 查詢） |
| `meeting_instances` | `(created_by_vexa_user_id, created_at DESC)` | 全局 Meetings 頁面分頁（跨專案 + 無專案） |
| `meeting_instances` | `status` | 查詢所有進行中的會議（ACTIVE），用於服務重啟後恢復 session |
| `meeting_instances` | `(created_by_vexa_user_id, status)` | activeBotCount 查詢（`GET /me` 及建立會議前的並發檢查） |

---

## 六、環境變數

> **環境變數正本見 `06-後端架構.md §十`**（完整清單，避免多處重複而 drift）。

與資料庫直接相關者：

```bash
# 連線字串尾端加 ?schema=app，確保 Prisma 預設操作 app schema
DATABASE_URL="postgresql://postgres:[PWD]@db.[PROJ].supabase.co:5432/postgres?schema=app"
```

其餘（Supabase Storage / Dify / Anthropic / Recall / 邀請信 SMTP 等）一律以 06 §十 為準。

---

## 七、Migration / 建置步驟

本專案是 **`db push` 工作流**，沒有 `migrations/` 目錄。日常只要跑 `start.ps1`
（它會依序做完下面 2～4 步）；手動做的話：

```bash
# 1. 起本機基礎設施（Postgres + MinIO）
docker compose up -d --remove-orphans

# 2. 一次性遷移前置：先抹平破壞性差異，否則 db push 會因「刪掉有資料的欄位」失敗
cd backend
npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/01-pre-db-push.sql

# 3. 套用 schema（會自動建立 app schema 與所有表）
npx prisma db push
npx prisma generate

# 4. 一次性遷移後置：把身份資料從 Vexa 的 public.users / public.api_tokens 搬進 app schema
#    ⚠️ 不做的話，既有專案／會議的擁有者會對應到錯的人（不是資料遺失，是資料錯給人）
npx prisma db execute --schema prisma/schema.prisma --file scripts/sql/02-post-db-push.sql

# 5. 確認 Storage bucket 已建立（本機 MinIO 由 compose 的 minio-init 自動建）
# bucket name: meeting-materials / private / 15 MB
# allowed MIME: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/plain, text/markdown
```

兩個 SQL 都是**冪等**的：跑過就是 no-op，全新環境也安全。內容與理由見檔案開頭註解。

> `prisma db pull` 在移除 Vexa 之後**不再需要**（原本用途是同步 Vexa 的 public schema 定義）。
> `schemas = ["app"]` 下 db push 也不會動到 public 的舊表。

---

*文件結尾*
