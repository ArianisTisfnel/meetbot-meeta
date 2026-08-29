// ── 通用 ─────────────────────────────────────────────

export interface UserPermissions {
  canView: boolean
  canEdit: boolean
  canDelete: boolean
  canManage: boolean
  canMeeting: boolean
}

export interface UserSummary {
  userId: number
  email: string
  name: string | null
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  perPage: number
}

// ── 使用者 ────────────────────────────────────────────

export interface CurrentUser {
  userId: number
  email: string
  name: string | null
  maxConcurrentBots: number
  activeBotCount: number
}

// ── 專案 ─────────────────────────────────────────────

export interface ProjectListItem {
  id: string
  name: string
  role: 'owner' | 'member'
  permissions: UserPermissions
  memberCount: number
  materialCount: number
  activeMeetingCount: number
  createdAt: string
}

export interface ProjectDetail {
  id: string
  name: string
  role: 'owner' | 'member'
  permissions: UserPermissions
  owner: UserSummary
  memberCount: number
  materialCount: number
  activeMeetingCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectListResponse {
  items: ProjectListItem[]
  total: number
}

// ── 成員 ─────────────────────────────────────────────

export interface ProjectMember {
  id: string
  userId: number
  email: string
  name: string | null
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
  invitedAt: string
}

export interface PendingInvitation {
  id: string
  email: string
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
  expiresAt: string
  invitedAt: string
}

export interface MembersResponse {
  owner: UserSummary
  members: ProjectMember[]
  pendingInvitations: PendingInvitation[]
}

/** 建立邀請後的回傳（含可手動轉交的接受連結） */
export interface InvitationResult extends PendingInvitation {
  status: string
  acceptUrl: string
  emailSent: boolean
}

/** 站內信箱：我的待處理邀請 */
export interface MyInvitation {
  id: string
  email: string
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
  status: string
  expiresAt: string
  invitedAt: string
  projectName: string | null
  inviterName: string | null
}

export interface MyInvitationsResponse {
  items: MyInvitation[]
}

// ── 資料 ─────────────────────────────────────────────

export type IndexingStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

export interface Material {
  id: string
  filename: string
  displayName: string
  sizeBytes: number
  mimeType: string
  indexingStatus: IndexingStatus
  indexingError?: string | null
  uploadedBy: UserSummary
  uploadedAt: string
  updatedAt?: string
}

export type PaginatedMaterials = PaginatedResponse<Material>

// ── 活動紀錄 ───────────────────────────────────────────

export type ActivityAction =
  | 'MATERIAL_UPLOAD'
  | 'MATERIAL_DELETE'
  | 'MEMBER_INVITE'
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'MEMBER_PERMISSION_UPDATE'
  | 'MEETING_CREATE'
  | 'MEETING_DELETE'
  | 'PROJECT_RENAME'

export interface ActivityItem {
  id: string
  action: ActivityAction
  targetLabel: string
  metadata?: Record<string, unknown> | null
  actor: UserSummary
  createdAt: string
}

export type PaginatedActivity = PaginatedResponse<ActivityItem>

// ── 會議 ─────────────────────────────────────────────

export type MeetingStatus = 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED'

export interface ActionItem {
  task: string
  owner: string
}

export interface MeetingListItem {
  id: string
  name: string
  googleMeetUrl?: string
  status: MeetingStatus
  projectId?: string | null
  projectName?: string | null
  startedAt: string | null
  endedAt: string | null
  /** 目前使用者是否可刪除此會議（專案會議＝擁有者、全局會議＝建立者）。 */
  canDelete: boolean
  createdAt: string
}

export interface MeetingDetail {
  id: string
  name: string
  googleMeetUrl: string
  status: MeetingStatus
  projectId?: string | null
  projectName?: string | null
  createdBy: UserSummary
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  actionItems: ActionItem[]
  keyTopics: string[] | null
  decisions: string[] | null
  /** 會後完整逐字稿是否已存進 Storage（true 才顯示「查看逐字稿」）。 */
  hasTranscript: boolean
  /** 目前使用者是否可刪除此會議（專案會議＝擁有者、全局會議＝建立者）。 */
  canDelete: boolean
  createdAt: string
  updatedAt: string
}

/** GET /meetings/:id/transcript 回應：會後完整逐字稿 Markdown（無則為 null）。 */
export interface MeetingTranscriptResponse {
  markdown: string | null
}

export type PaginatedMeetings = PaginatedResponse<MeetingListItem>

// ── 逐字稿 ────────────────────────────────────────────

export interface TranscriptSegment {
  text: string
  speaker: string | null
  startTime: number
  endTime: number
  language: string | null
  segmentId: string | null
  createdAt: string
}

export interface TranscriptResponse {
  items: TranscriptSegment[]
  total: number
  page: number
  perPage: number
}

// ── 行事曆 ────────────────────────────────────────────

export type RsvpStatus = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED' | 'PENDING'

/** 成員的 Google Calendar 同步狀態：未連結與授權失效要分開，使用者的下一步不同。 */
export type CalendarSyncState = 'synced' | 'unsynced' | 'expired'

export interface CalendarMemberDto {
  userId: number
  name: string | null
  email: string
  isOwner: boolean
  syncState: CalendarSyncState
}

export interface CalendarAttendeeDto {
  userId: number
  rsvp: RsvpStatus
  respondedAt: string | null
}

/** 行事曆上的會議。時間一律是 ISO 8601 絕對時間（UTC），由前端換成本地時間顯示。 */
export interface CalendarMeetingDto {
  id: string
  projectId: string | null
  projectName?: string | null
  name: string
  googleMeetUrl: string
  status: 'SCHEDULED' | 'PENDING' | 'ACTIVE' | 'ENDED' | 'FAILED' | 'CANCELED'
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  timezone: string | null
  createdByUserId: number
  attendees: CalendarAttendeeDto[]
}

/** 從成員 GCal 匯入的忙碌時段：只有起訖，沒有標題（隱私）。 */
export interface BusyBlockDto {
  id: string
  userId: number
  startAt: string
  endAt: string
}

export interface ProjectCalendarResponse {
  members: CalendarMemberDto[]
  meetings: CalendarMeetingDto[]
  busyBlocks: BusyBlockDto[]
}

export interface GlobalCalendarResponse {
  meetings: CalendarMeetingDto[]
  busyBlocks: BusyBlockDto[]
  /** 這批會議的與會者姓名對照（全域層跨專案，沒有單一成員名單可查） */
  people: Array<{ userId: number; name: string | null; email: string }>
}

export interface FreeSlotDto {
  start: string
  end: string
}

export interface FreeSlotsResponse {
  slots: FreeSlotDto[]
  /** 這些成員尚未同步 GCal → 結果僅依已知忙碌計算（spec §4.3） */
  unsyncedMembers: Array<{
    userId: number
    name: string | null
    email: string
    syncState: CalendarSyncState
  }>
}
