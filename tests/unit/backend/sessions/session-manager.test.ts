import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

// session-manager 現在透過 provider 抽象層派 bot / 取逐字稿 / 讓 bot 離開。
const mockBotProvider = vi.hoisted(() => ({
  join: vi.fn(),
  getTranscript: vi.fn().mockResolvedValue([]),
  speak: vi.fn().mockResolvedValue(undefined),
  sendChat: vi.fn().mockResolvedValue(undefined),
  leave: vi.fn().mockResolvedValue(undefined),
}))
const generateSummaryAsync = vi.hoisted(() => vi.fn())

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/sessions/wake-word-detector', () => ({
  handleTranscriptSegment: vi.fn(),
  handlePartialSegment: vi.fn(),
  handleChatMessage: vi.fn(),
  handleBargeIn: vi.fn().mockResolvedValue(undefined),
  PENDING_VOICE: '好的，我收到了，請稍候。',
  ERROR_VOICE: '抱歉，查詢時發生錯誤，請稍後再試。',
  PROGRESS_VOICE: '不好意思讓大家久等了，我還在查，馬上就好。',
}))
// interjection 直接 import 真 env（會 process.exit）與 Anthropic client → 整包 mock 掉
vi.mock('../../../../backend/src/sessions/interjection', () => ({
  recordConversation: vi.fn(),
  clearInterjection: vi.fn(),
  startIcebreaker: vi.fn(),
}))
vi.mock('../../../../backend/src/sessions/summary.service', () => ({ generateSummaryAsync }))

import { activeSessions } from '../../../../backend/src/sessions/session-store'
import {
  startBotSession,
  handleSessionClose,
  closeSession,
  formatContentCardLine,
  loadKbContentCard,
} from '../../../../backend/src/sessions/session-manager'
import type { BotSession } from '../../../../backend/src/provider/types'
import type { MeetingSession } from '../../../../backend/src/types/session'

function fakeBotSession(overrides: Partial<BotSession> = {}): BotSession {
  return {
    provider: 'recall',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    providerMeetingId: 42,
    adapter: { name: 'recall', sendChat: vi.fn().mockResolvedValue(undefined) } as any,
    state: {},
    ...overrides,
  }
}

function putSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  const session: MeetingSession = {
    meetingInstanceId: 'meet-1',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    isSpeaking: false,
    lastWakeAt: 0,
    processedSegmentIds: new Set(),
    botSession: fakeBotSession(),
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
    ...overrides,
  }
  activeSessions.set(session.meetingInstanceId, session)
  return session
}

const BASE = {
  meetingInstanceId: 'meet-1',
  googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
  nativeMeetingId: 'abc-defg-hij',
  difyDatasetId: 'dataset-abc',
}

describe('startBotSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('bot 被 admitted（join resolve）→ DB 轉 ACTIVE、發歡迎訊息、session 入 Map', async () => {
    const bs = fakeBotSession()
    mockBotProvider.join.mockResolvedValue(bs)

    await startBotSession(BASE)

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'meet-1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    )
    expect(activeSessions.get('meet-1')?.botSession).toBe(bs)
    // 歡迎訊息走 adapter.sendChat
    await new Promise((r) => setTimeout(r, 0))
    expect(bs.adapter.sendChat).toHaveBeenCalled()
  })

  it('兩個 provider 都進不去（join reject）→ DB 轉 FAILED、session 移出 Map', async () => {
    mockBotProvider.join.mockRejectedValue(new Error('all providers failed'))

    await startBotSession(BASE)

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    expect(activeSessions.has('meet-1')).toBe(false)
  })

  it('等待期間被取消（Map 已被移除）→ 收掉剛 admitted 的 bot，不寫 ACTIVE', async () => {
    const bs = fakeBotSession()
    // join 期間模擬取消：在 resolve 前清掉 Map
    mockBotProvider.join.mockImplementation(async () => {
      activeSessions.delete('meet-1')
      return bs
    })

    await startBotSession(BASE)

    expect(mockBotProvider.leave).toHaveBeenCalledWith(bs)
    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }),
    )
  })
})

describe('handleSessionClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
    mockPrisma.meetingInstance.updateMany.mockResolvedValue({ count: 0 })
  })

  it('被呼叫兩次（雙重清理競態）→ 第二次 early return，只更新 DB 一次', async () => {
    putSession()

    await handleSessionClose('meet-1')
    await handleSessionClose('meet-1')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledTimes(1)
  })

  it('無 in-memory session（重啟後遺失）→ 仍把卡在 ACTIVE 的會議收尾成 ENDED + summary sentinel', async () => {
    mockPrisma.meetingInstance.updateMany.mockResolvedValue({ count: 1 })

    await handleSessionClose('meet-1')

    expect(mockPrisma.meetingInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // summary: null 是必要條件，不是可有可無的保險——見下一個案例
        where: { id: 'meet-1', status: 'ACTIVE', summary: null },
        data: expect.objectContaining({ status: 'ENDED', summary: '' }),
      }),
    )
    // 沒有 session 就沒有逐字稿來源，不觸發摘要、不動 bot
    expect(generateSummaryAsync).not.toHaveBeenCalled()
    expect(mockBotProvider.leave).not.toHaveBeenCalled()
  })

  // 正常路徑是 Map.delete → await update 轉 ENDED → 背景生摘要。第二次觸發若落在
  // Map.delete 之後、update 完成之前，DB 還是 ACTIVE，只鎖 status 會把 summary 寫成
  // '' 哨兵；真摘要稍後才寫回，但前端看到哨兵已經停止輪詢 → 使用者以為摘要不見了。
  it('雙重觸發卡在 Map 已刪、DB 未轉 ENDED 之間 → 不可寫入 summary 哨兵', async () => {
    await handleSessionClose('meet-1')

    const where = mockPrisma.meetingInstance.updateMany.mock.calls[0][0].where
    expect(where).toHaveProperty('summary', null)
  })

  it('正常結束（ENDED）→ 觸發摘要、讓 bot 離開', async () => {
    const session = putSession()

    await handleSessionClose('meet-1')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ENDED' }) }),
    )
    expect(generateSummaryAsync).toHaveBeenCalledTimes(1)
    expect(mockBotProvider.leave).toHaveBeenCalledWith(session.botSession)
  })

  it('reason=failed → DB 轉 FAILED，不觸發摘要', async () => {
    putSession()

    await handleSessionClose('meet-1', 'failed')

    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(generateSummaryAsync).not.toHaveBeenCalled()
  })
})

describe('closeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeSessions.clear()
  })

  it('從 Map 移除並讓 bot 離開（不更新 DB、不觸發摘要）', async () => {
    const session = putSession()

    await closeSession('meet-1')

    expect(activeSessions.has('meet-1')).toBe(false)
    expect(mockBotProvider.leave).toHaveBeenCalledWith(session.botSession)
    expect(generateSummaryAsync).not.toHaveBeenCalled()
  })
})

describe('formatContentCardLine', () => {
  it('有真摘要 → 檔名後面接摘要內容', () => {
    expect(formatContentCardLine({ displayName: '簡章.pdf', contentCard: '報名期間 6/1–6/30' })).toBe(
      '【簡章.pdf】報名期間 6/1–6/30',
    )
  })

  it("contentCard 為空字串（已嘗試但抽不出內容）→ 標『抽不出內容』，不是裸檔名", () => {
    const line = formatContentCardLine({ displayName: '掃描檔.pdf', contentCard: '' })
    expect(line).toContain('【掃描檔.pdf】')
    expect(line).toContain('抽不出內容')
    expect(line).not.toBe('【掃描檔.pdf】')
  })

  it('contentCard 為 null（尚未產生）→ 標『尚未產生』，不是裸檔名', () => {
    const line = formatContentCardLine({ displayName: '附件3_final.pdf', contentCard: null })
    expect(line).toContain('【附件3_final.pdf】')
    expect(line).toContain('尚未產生')
    expect(line).not.toBe('【附件3_final.pdf】')
  })
})

describe('loadKbContentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('有摘要的文件排在沒摘要的前面，避免截斷時被佔位行擠掉', async () => {
    mockPrisma.material.findMany.mockResolvedValue([
      { displayName: '沒摘要.pdf', contentCard: null },
      { displayName: '有摘要.pdf', contentCard: '這份文件講的是報名規則' },
    ])
    const session = putSession()

    await loadKbContentCard(session, 'dataset-abc')

    const lines = session.kbContentCard!.split('\n')
    expect(lines[0]).toBe('【有摘要.pdf】這份文件講的是報名規則')
    expect(lines[1]).toContain('尚未產生')
  })
})
