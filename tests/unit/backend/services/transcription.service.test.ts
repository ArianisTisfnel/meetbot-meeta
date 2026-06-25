import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'
import { mockVexa } from '../../../mocks/vexa.mock'

const mockBotProvider = vi.hoisted(() => ({ getTranscript: vi.fn().mockResolvedValue([]) }))

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/lib/vexa', () => mockVexa)
vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/types/env', () => ({
  env: { VEXA_API_URL: 'http://vexa.test', VEXA_WS_URL: 'ws://vexa.test' },
}))
vi.mock('../../../../backend/src/sessions/session-store', () => ({
  activeSessions: new Map(),
}))

import { getTranscriptions } from '../../../../backend/src/services/transcription.service'
import { activeSessions } from '../../../../backend/src/sessions/session-store'

const MOCK_SEGMENTS = [
  { segment_id: 'seg-1', text: '第一段', speaker: 'A', start: 10.0, end: 12.0, language: 'zh', completed: true },
  { segment_id: 'seg-2', text: '第二段', speaker: 'B', start: 15.0, end: 18.0, language: 'zh', completed: true },
  { segment_id: 'seg-3', text: '第三段', speaker: 'A', start: 20.0, end: 22.0, language: 'zh', completed: true },
]

const BASE_PARAMS = {
  meetingInstanceId: 'meet-uuid-1',
  creatorApiTokenId: 42,
  platform: 'google_meet',
  vexaNativeMeetingId: 'abc-defg-hij',
}

describe('getTranscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(activeSessions as Map<string, any>).clear()
    mockVexa.getTranscriptions.mockResolvedValue(MOCK_SEGMENTS)
    mockPrisma.$queryRaw.mockResolvedValue([{ token: 'creator-token' }])
  })

  it('sinceStartTime >= 15 → 只回傳 start >= 15 的 segment（含邊界值）', async () => {
    const result = await getTranscriptions({ ...BASE_PARAMS, sinceStartTime: 15.0 })

    expect(result.items).toHaveLength(2)
    expect(result.items[0].startTime).toBe(15.0)  // seg-2（剛好等於）
    expect(result.items[1].startTime).toBe(20.0)  // seg-3
    expect(result.total).toBe(2)
  })

  it('欄位映射：回傳物件含 startTime/endTime（camelCase），不含 start/end', async () => {
    const result = await getTranscriptions(BASE_PARAMS)

    expect(result.items).toHaveLength(3)
    const item = result.items[0]
    expect(item).toHaveProperty('startTime')
    expect(item).toHaveProperty('endTime')
    expect(item).not.toHaveProperty('start')
    expect(item).not.toHaveProperty('end')
    expect(item.startTime).toBe(10.0)
    expect(item.endTime).toBe(12.0)
  })

  it('ACTIVE 會議（無 botSession）：從 activeSessions 取 token 走 Vexa REST，不查 DB', async () => {
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', {
      creatorVexaToken: 'session-token',
      botSession: null,
    })

    await getTranscriptions(BASE_PARAMS)

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled()
    expect(mockVexa.getTranscriptions).toHaveBeenCalledWith(
      'google_meet',
      'abc-defg-hij',
      'session-token',
    )
  })

  it('ACTIVE 會議（有 botSession）：走 provider 抽象層取逐字稿（provider-agnostic），不碰 Vexa REST', async () => {
    const botSession = { provider: 'recall', adapter: {}, state: {} }
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', {
      creatorVexaToken: 'session-token',
      botSession,
    })
    mockBotProvider.getTranscript.mockResolvedValue([
      { segmentId: 'r-1', text: 'recall 段', speaker: 'A', startTime: 10, endTime: 12, language: 'en' },
    ])

    const result = await getTranscriptions(BASE_PARAMS)

    expect(mockBotProvider.getTranscript).toHaveBeenCalledWith(botSession)
    expect(mockVexa.getTranscriptions).not.toHaveBeenCalled()
    expect(result.items[0].startTime).toBe(10)
    expect(result.items[0]).not.toHaveProperty('start')
  })

  it('token 不存在 → 503 CREATOR_TOKEN_UNAVAILABLE', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([])

    await expect(getTranscriptions(BASE_PARAMS)).rejects.toMatchObject({
      code: 'CREATOR_TOKEN_UNAVAILABLE',
      statusCode: 503,
    })
  })
})
