import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockVexa } from '../../../mocks/vexa.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
vi.mock('../../../../backend/src/lib/dify', () => ({
  uploadTranscriptFile: vi.fn().mockResolvedValue('file-id-1'),
  generateSummary: vi.fn().mockResolvedValue({
    summary: '摘要',
    actionItems: [],
    keyTopics: [],
    decisions: [],
  }),
}))
vi.mock('../../../../backend/src/lib/supabase', () => ({
  upsertFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    VEXA_WS_URL: 'ws://localhost:8056',
    SUPABASE_URL: 'http://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    SUPABASE_STORAGE_BUCKET: 'test-bucket',
    DIFY_API_BASE: 'http://dify.test',
    DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY: 'app-test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  },
}))
vi.mock('../../../../backend/src/sessions/wake-word-detector', () => ({
  handleTranscriptSegment: vi.fn(),
  handleChatMessage: vi.fn(),
}))

// mock ws module
vi.mock('ws', () => {
  const EventEmitter = require('events')
  const MockWS = vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter()
    return {
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    }
  })
  return { default: MockWS }
})

import { activeSessions } from '../../../../backend/src/sessions/session-store'
import {
  handleBotStatusChange,
  handleSessionClose,
  closeSession,
  createSession,
} from '../../../../backend/src/sessions/session-manager'
import type { MeetingSession } from '../../../../backend/src/types/session'

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    meetingInstanceId: 'meet-1',
    vexaMeetingId: 42,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    creatorVexaToken: 'tok-123',
    isSpeaking: false,
    lastWakeAt: 0,
    processedSegmentIds: new Set(),
    wsConnection: {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as any,
    difyConversationId: null,
    lastQuestionAt: 0,
    ...overrides,
  }
}

describe('handleBotStatusChange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('active → Prisma update ACTIVE + startedAt，呼叫 chatSend 歡迎訊息', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await handleBotStatusChange(session, 'active')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    )
    // chatSend 為非同步 fire-and-forget，等待一個 tick
    await new Promise((r) => setTimeout(r, 10))
    expect(mockVexa.chatSend).toHaveBeenCalled()
  })

  it('completed → 呼叫 handleSessionClose，DB 更新為 ENDED', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await handleBotStatusChange(session, 'completed')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ENDED' }),
      }),
    )
    expect(activeSessions.has('meet-1')).toBe(false)
  })

  it('failed → DB 更新為 FAILED', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await handleBotStatusChange(session, 'failed')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
  })

  it('needs_human_help → DB 更新為 FAILED（與 failed 相同處理）', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await handleBotStatusChange(session, 'needs_human_help')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
  })
})

describe('handleSessionClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('被呼叫兩次（雙重清理競態）→ 第二次因 Map 已空而 early return，只更新 DB 一次', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await handleSessionClose('meet-1')
    await handleSessionClose('meet-1')  // 第二次呼叫

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledTimes(1)
  })
})

describe('closeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
  })

  it('closeSession 後，WS close 不再觸發重連（activeSessions 已移除）', async () => {
    const session = makeSession()
    activeSessions.set('meet-1', session)

    await closeSession('meet-1')

    // session 從 Map 移除
    expect(activeSessions.has('meet-1')).toBe(false)
    // WS close 被呼叫
    expect(session.wsConnection?.close).toHaveBeenCalled()
  })
})
