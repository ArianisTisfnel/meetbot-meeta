import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockBotProvider = vi.hoisted(() => ({ getTranscript: vi.fn().mockResolvedValue([]) }))

vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/sessions/session-store', () => ({
  activeSessions: new Map(),
}))

import { getTranscriptions } from '../../../../backend/src/services/transcription.service'
import { activeSessions } from '../../../../backend/src/sessions/session-store'

const MOCK_SEGMENTS = [
  { segmentId: 'seg-1', text: '第一段', speaker: 'A', startTime: 10.0, endTime: 12.0, language: 'zh' },
  { segmentId: 'seg-2', text: '第二段', speaker: 'B', startTime: 15.0, endTime: 18.0, language: 'zh' },
  { segmentId: 'seg-3', text: '第三段', speaker: 'A', startTime: 20.0, endTime: 22.0, language: 'zh' },
]

describe('getTranscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(activeSessions as Map<string, any>).clear()
  })

  it('無 session → 回傳空陣列', async () => {
    const result = await getTranscriptions({ meetingInstanceId: 'meet-uuid-1' })

    expect(result.items).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(mockBotProvider.getTranscript).not.toHaveBeenCalled()
  })

  it('有 botSession → 走 provider 抽象層取逐字稿', async () => {
    const botSession = { provider: 'recall', adapter: {}, state: {} }
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', { botSession })
    mockBotProvider.getTranscript.mockResolvedValue(MOCK_SEGMENTS)

    const result = await getTranscriptions({ meetingInstanceId: 'meet-uuid-1' })

    expect(mockBotProvider.getTranscript).toHaveBeenCalledWith(botSession)
    expect(result.items).toHaveLength(3)
    expect(result.total).toBe(3)
  })

  it('sinceStartTime >= 15 → 只回傳 startTime >= 15 的 segment（含邊界值）', async () => {
    const botSession = { provider: 'recall', adapter: {}, state: {} }
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', { botSession })
    mockBotProvider.getTranscript.mockResolvedValue(MOCK_SEGMENTS)

    const result = await getTranscriptions({ meetingInstanceId: 'meet-uuid-1', sinceStartTime: 15.0 })

    expect(result.items).toHaveLength(2)
    expect(result.items[0].startTime).toBe(15.0)
    expect(result.items[1].startTime).toBe(20.0)
    expect(result.total).toBe(2)
  })

  it('欄位映射：回傳物件含 startTime/endTime（camelCase），不含 start/end', async () => {
    const botSession = { provider: 'recall', adapter: {}, state: {} }
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', { botSession })
    mockBotProvider.getTranscript.mockResolvedValue(MOCK_SEGMENTS)

    const result = await getTranscriptions({ meetingInstanceId: 'meet-uuid-1' })

    expect(result.items).toHaveLength(3)
    const item = result.items[0]
    expect(item).toHaveProperty('startTime')
    expect(item).toHaveProperty('endTime')
    expect(item).not.toHaveProperty('start')
    expect(item).not.toHaveProperty('end')
    expect(item.startTime).toBe(10.0)
    expect(item.endTime).toBe(12.0)
  })

  it('session 存在但 botSession 為 null → 回傳空陣列', async () => {
    ;(activeSessions as Map<string, any>).set('meet-uuid-1', { botSession: null })

    const result = await getTranscriptions({ meetingInstanceId: 'meet-uuid-1' })

    expect(result.items).toHaveLength(0)
    expect(mockBotProvider.getTranscript).not.toHaveBeenCalled()
  })
})
