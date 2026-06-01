// ── 通用 ─────────────────────────────────────────────

export interface UserPermissions {
  canView: boolean
  canEdit: boolean
  canDelete: boolean
  canManage: boolean
  canMeeting: boolean
}

export interface UserSummary {
  vexaUserId: number
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
  vexaUserId: number
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
  vexaUserId: number
  email: string
  name: string | null
  canView: boolean
  canEdit: boolean
  canMeeting: boolean
  invitedAt: string
}

export interface MembersResponse {
  owner: UserSummary
  members: ProjectMember[]
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
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'MEMBER_PERMISSION_UPDATE'
  | 'MEETING_CREATE'
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
  createdAt: string
}

export interface MeetingDetail {
  id: string
  name: string
  googleMeetUrl: string
  status: MeetingStatus
  vexaMeetingId?: number | null
  projectId?: string | null
  projectName?: string | null
  createdBy: UserSummary
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  actionItems: ActionItem[]
  createdAt: string
  updatedAt: string
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
