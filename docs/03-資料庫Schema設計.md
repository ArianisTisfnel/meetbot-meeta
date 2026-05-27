# 資料庫 Schema 設計

|項目|內容|
|----|-----|
|文件版本|v1.1|
|撰寫日期|2026-05-26|
|依據文件|`01-專案目標.md`、`02-使用者需求.md`|
|ORM|Prisma（multiSchema）|
|資料庫|Supabase PostgreSQL|

---

## 一、總體設計原則

### 1.1 雙層 Schema 隔離

```
Supabase PostgreSQL
├── schema: public          ← Vexa-lite 自動管理（只讀，透過 prisma db pull 同步定義）
│   ├── users               ← 使用者基本資料、max_concurrent_bots
│   ├── meetings            ← Bot 會議記錄、狀態、bot_container_id
│   ├── transcriptions      ← 逐字稿 segments
│   └── meeting_sessions    ← 會議 session 對應
│
└── schema: app             ← 應用獨立管理（Prisma migrate）
    ├── projects
    ├── project_members
    ├── materials
    ├── material_edit_history
    └── meeting_instances
```

### 1.2 跨 Schema 關聯策略

- **不建立跨 schema 外鍵約束**（FK），避免 Vexa 升級時 migration 卡住
- 以 `vexa_user_id`（Integer，對應 `public.users.id`）作為使用者的**邏輯關聯鍵**
- 以 `vexa_meeting_id`（Integer，對應 `public.meetings.id`）作為會議的**邏輯關聯鍵**
- App 對 `public` schema 採**唯讀**模式，Vexa 表定義透過 `prisma db pull` 同步

### 1.3 Soft Delete 策略

- `projects`、`materials` 採 soft delete（`deleted_at` 欄位）
- `meeting_instances` **不可刪除**（無 `deleted_at`），保護歷史逐字稿
- `project_members`、`material_edit_history` 採硬刪除或不刪除（歷史紀錄）

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
  schemas  = ["app", "public"]
}

// ══════════════════════════════════════════════════
// app schema：應用核心業務邏輯
// ══════════════════════════════════════════════════

/// 專案實例
model Project {
  id              String    @id @default(uuid())
  name            String
  /// 所有者 ID，邏輯關聯 public.users.id（無 FK 約束）
  ownerVexaUserId Int       @map("owner_vexa_user_id")
  /// 對應此專案的 Dify Knowledge Base ID（建立專案時同步建立）
  difyDatasetId   String    @map("dify_dataset_id")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  /// Soft delete：所有者刪除專案時設定
  deletedAt       DateTime? @map("deleted_at")

  members          ProjectMember[]
  materials        Material[]
  editHistory      MaterialEditHistory[]
  meetingInstances MeetingInstance[]

  @@index([ownerVexaUserId])
  @@index([deletedAt])
  @@map("projects")
  @@schema("app")
}

/// 專案參與者（不包含所有者，所有者由 projects.owner_vexa_user_id 記錄）
model ProjectMember {
  id                  String   @id @default(uuid())
  projectId           String   @map("project_id")
  /// 參與者 ID，邏輯關聯 public.users.id
  vexaUserId          Int      @map("vexa_user_id")
  /// 檢視權：查看資料清單、歷史紀錄、成員清單、會議逐字稿
  canView             Boolean  @default(true) @map("can_view")
  /// 編輯權：上傳 / 刪除資料檔案
  canEdit             Boolean  @default(false) @map("can_edit")
  /// 邀請人 ID，邏輯關聯 public.users.id（目前只有所有者可邀請）
  invitedByVexaUserId Int      @map("invited_by_vexa_user_id")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId], references: [id])

  /// 同一使用者在同一專案只能有一筆參與者紀錄
  @@unique([projectId, vexaUserId])
  @@index([vexaUserId])
  @@map("project_members")
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
  uploadedByVexaUserId Int            @map("uploaded_by_vexa_user_id")
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
  performedByVexaUserId Int        @map("performed_by_vexa_user_id")
  performedAt           DateTime   @default(now()) @map("performed_at")

  project  Project  @relation(fields: [projectId], references: [id])
  material Material @relation(fields: [materialId], references: [id])

  @@index([projectId, performedAt(sort: Desc)])
  @@index([materialId])
  @@map("material_edit_history")
  @@schema("app")
}

/// 會議實例（不可刪除，保護歷史逐字稿）
model MeetingInstance {
  id                   String        @id @default(uuid())
  projectId            String        @map("project_id")
  /// 對應 Vexa 的 meeting ID（整數，邀請 Bot 後由 POST /bots 回傳）
  /// 在 Bot 成功加入前為 null（PENDING 狀態）
  vexaMeetingId        Int?          @map("vexa_meeting_id")
  /// Google Meet 的 native_meeting_id（例如 "abc-defg-hij"）
  /// 由 googleMeetUrl 解析取得，用於呼叫 Vexa Bot API（/speak、/chat 等）
  /// 在 Bot 成功加入前為 null
  vexaNativeMeetingId  String?       @map("vexa_native_meeting_id")
  /// 會議名稱（可自訂，預設由系統生成，例如「會議 2026-05-26 14:30」）
  name                 String
  /// Google Meet URL（使用者輸入或從 meet.new 取得）
  googleMeetUrl        String        @map("google_meet_url")
  status               MeetingStatus @default(PENDING)
  /// 邀請 Bot 的使用者 ID（邏輯關聯 public.users.id）
  createdByVexaUserId  Int           @map("created_by_vexa_user_id")
  /// 邀請 Bot 時所使用的 API token 記錄 ID（邏輯關聯 public.api_tokens.id）
  /// 用於服務重啟後恢復 MeetingSession（重新建立 WebSocket、呼叫 Vexa Bot API）
  /// 不存 token 字串，只存指向 public.api_tokens 的整數 ID，避免資料重複
  creatorApiTokenId    Int           @map("creator_api_token_id")
  /// 會議實際開始時間（Vexa Bot 成功加入後記錄）
  startedAt            DateTime?     @map("started_at")
  /// 會議結束時間（Bot 離開後記錄）
  endedAt              DateTime?     @map("ended_at")
  /// Dify 總結工作流生成的會議摘要（會議結束後填入）
  summary              String?
  /// Dify 提取的交辦事項（JSONB 陣列，會議結束後填入）
  /// 格式：["事項1", "事項2", ...]
  actionItems          Json?         @map("action_items")
  createdAt            DateTime      @default(now()) @map("created_at")
  updatedAt            DateTime      @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId], references: [id])

  @@index([projectId, createdAt(sort: Desc)])
  @@index([vexaMeetingId])
  @@index([status])
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

enum MeetingStatus {
  PENDING // 會議實例已建立，Bot 尚未加入（Vexa API 呼叫中）
  ACTIVE  // Bot 已成功加入會議，逐字稿進行中
  ENDED   // 會議已結束，摘要生成完畢

  @@map("meeting_status")
  @@schema("app")
}

// ══════════════════════════════════════════════════
// public schema：透過 `prisma db pull` 自動同步 Vexa 表定義
// 以下為參考用途，實際定義由 prisma db pull 產生
// ══════════════════════════════════════════════════

// model User {
//   id                Int      @id @default(autoincrement())
//   email             String
//   name              String?
//   maxConcurrentBots Int      @map("max_concurrent_bots")
//   createdAt         DateTime @map("created_at")
//   data              Json
//   @@map("users")
//   @@schema("public")
// }

// model Meeting {
//   id                 Int       @id @default(autoincrement())
//   userId             Int       @map("user_id")
//   platform           String
//   platformSpecificId String?   @map("platform_specific_id")
//   status             String
//   botContainerId     String?   @map("bot_container_id")
//   startTime          DateTime? @map("start_time")
//   endTime            DateTime? @map("end_time")
//   data               Json
//   createdAt          DateTime  @map("created_at")
//   updatedAt          DateTime  @map("updated_at")
//   @@map("meetings")
//   @@schema("public")
// }

// model Transcription {
//   id         Int      @id @default(autoincrement())
//   meetingId  Int      @map("meeting_id")
//   startTime  Float    @map("start_time")
//   endTime    Float    @map("end_time")
//   text       String
//   speaker    String?
//   language   String?
//   createdAt  DateTime? @map("created_at")
//   sessionUid String?  @map("session_uid")
//   segmentId  String?  @map("segment_id")
//   @@map("transcriptions")
//   @@schema("public")
// }
```

---

## 三、Table 關聯圖

```
public.users (Vexa)
    │ (邏輯關聯，無 FK)
    ├─── app.projects.owner_vexa_user_id
    ├─── app.project_members.vexa_user_id
    ├─── app.project_members.invited_by_vexa_user_id
    ├─── app.materials.uploaded_by_vexa_user_id
    ├─── app.material_edit_history.performed_by_vexa_user_id
    └─── app.meeting_instances.created_by_vexa_user_id

public.meetings (Vexa)
    │ (邏輯關聯，無 FK)
    └─── app.meeting_instances.vexa_meeting_id

app.projects
    ├─── app.project_members.project_id  ──►  [1:N]
    ├─── app.materials.project_id        ──►  [1:N]
    ├─── app.material_edit_history.project_id ──► [1:N]
    └─── app.meeting_instances.project_id ──► [1:N]

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

### 4.4 MeetingInstance 的 vexaMeetingId / vexaNativeMeetingId 為何可為 null

建立會議實例時，需呼叫 Vexa API（`POST /bots`）讓 Bot 加入 Google Meet。
此 API 呼叫為非同步，且可能失敗。因此：

- **建立中**（`status = PENDING`）：`vexaMeetingId = null`、`vexaNativeMeetingId = null`
- **成功加入**（`status = ACTIVE`）：
  - `vexaMeetingId` = Vexa 回傳的 `meeting.id`（整數，用於查詢逐字稿）
  - `vexaNativeMeetingId` = 由 `googleMeetUrl` 解析出的 Meet code（例如 `abc-defg-hij`），
    用於呼叫 Vexa 的 `/speak`、`/chat`、`DELETE /bots` 等 Bot 控制 API
- **加入失敗**：保留 `PENDING` 狀態並記錄錯誤，UI 顯示重試選項

> **為何需要兩個不同的 ID？**
> Vexa 的逐字稿查詢（`public.transcriptions`）使用整數 `meeting_id`，
> 而 Bot 控制 API（`/speak`、`/chat` 等）使用 `{platform}/{native_meeting_id}` 路徑，
> 兩者不可互換。

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
  vexaMeetingId: number             // public.meetings.id（整數，用於查詢逐字稿）
  platform: string                  // 固定為 "google_meet"
  nativeMeetingId: string           // Google Meet code，例如 "abc-defg-hij"
                                    // 用於呼叫 Vexa Bot API（/speak、/chat、DELETE /bots）
  difyDatasetId: string             // 決定查詢哪個 Knowledge Base
  creatorVexaToken: string          // 邀請者的 vexa-token（用於呼叫 Vexa Bot API）
                                    // 服務重啟時從 public.api_tokens WHERE id = creatorApiTokenId 取得
  isSpeaking: boolean               // 防語音重疊（TTS 播放中時為 true）
  lastWakeAt: number                // 防重複觸發的 timestamp（ms）
  processedSegmentIds: Set<string>  // 已處理過的 segmentId，防止喚醒詞重複觸發
  wsConnection: WebSocket           // 指向 Vexa API Gateway 的 /ws 多工 WebSocket
}

// session 儲存在後端記憶體（Map），不需要持久化到資料庫
const activeSessions = new Map<string, MeetingSession>()
// key: meetingInstanceId
```

> **`platform` 與 `nativeMeetingId` 的來源**：
> 建立 `MeetingInstance` 時，`googleMeetUrl`（例如 `https://meet.google.com/abc-defg-hij`）
> 可解析出 `platform = "google_meet"` 與 `nativeMeetingId = "abc-defg-hij"`，
> 並存入 `meeting_instances.vexa_native_meeting_id` 欄位，供 session 恢復時使用。

---

## 五、索引設計總覽

| 資料表 | 索引欄位 | 用途 |
|--------|---------|------|
| `projects` | `owner_vexa_user_id` | 查詢某使用者擁有的所有專案 |
| `projects` | `deleted_at` | 過濾已刪除的專案 |
| `project_members` | `(project_id, vexa_user_id)` UNIQUE | 防重複邀請 + 查詢成員 |
| `project_members` | `vexa_user_id` | 查詢某使用者參與的所有專案 |
| `materials` | `(project_id, sha256)` UNIQUE | 判重 |
| `materials` | `(project_id, uploaded_at DESC)` | 專案資料清單分頁 |
| `materials` | `indexing_status` | Background job 輪詢 PROCESSING 狀態 |
| `material_edit_history` | `(project_id, performed_at DESC)` | 專案歷史紀錄分頁 |
| `material_edit_history` | `material_id` | 單一檔案的操作歷史 |
| `meeting_instances` | `(project_id, created_at DESC)` | 專案會議清單分頁 |
| `meeting_instances` | `vexa_meeting_id` | 接收 Vexa WS 狀態事件時查找對應實例 |
| `meeting_instances` | `status` | 查詢所有進行中的會議（ACTIVE），用於服務重啟後恢復 session |

---

## 六、環境變數（資料庫相關）

```bash
# Supabase Postgres（連線字串尾加 ?schema=app，確保 Prisma 預設操作 app schema）
DATABASE_URL="postgresql://postgres:[PWD]@db.[PROJ].supabase.co:5432/postgres?schema=app"

# Supabase（供後端 Service Role 存取 Storage）
SUPABASE_URL="https://[PROJ].supabase.co"
SUPABASE_SERVICE_ROLE_KEY="..."      # 絕對不可暴露給前端
SUPABASE_STORAGE_BUCKET="meeting-materials"

# Dify（兩把獨立 API Key，分別對應不同用途）
DIFY_API_BASE="https://api.dify.ai/v1"
DIFY_DATASET_API_KEY="dataset-..."   # Knowledge Base 操作：上傳/刪除文件、查詢索引狀態
DIFY_WORKFLOW_API_KEY="app-..."      # Chatflow Q&A 與 Summary 工作流呼叫
```

---

## 七、Migration 步驟

```bash
# 1. 啟動 Vexa-lite，等待 public schema migrate 完成
docker compose up -d vexa-lite

# 2. 建立 app schema
# 在 Supabase SQL Editor 執行：
# CREATE SCHEMA IF NOT EXISTS app;
# GRANT ALL ON SCHEMA app TO postgres;
# GRANT USAGE ON SCHEMA app TO authenticated;

# 3. 同步 Vexa 的 public schema 定義（只讀參考）
npx prisma db pull
# → 自動補充 public schema 的 model 定義到 schema.prisma
# → 保留需要的（User、Meeting、Transcription），刪除用不到的

# 4. 執行 app schema 的初始 migration
npx prisma migrate dev --name init_app_schema

# 5. 確認 Supabase Storage bucket 已建立
# bucket name: meeting-materials
# visibility: private
# file size limit: 15 MB
# allowed MIME types: application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/plain, text/markdown
```

---

*文件結尾*
