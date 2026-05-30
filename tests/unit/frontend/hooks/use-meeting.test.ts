import { describe, it, expect } from 'vitest'
import { computeRefetchInterval } from '../../../../frontend/src/hooks/use-meeting'
import type { MeetingDetail } from '../../../../frontend/src/types/api'

function makeMeeting(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: 'meeting-1',
    name: '測試會議',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    status: 'PENDING',
    createdBy: { vexaUserId: 1, email: 'test@example.com', name: 'Test' },
    startedAt: null,
    endedAt: null,
    summary: null,
    actionItems: [],
    createdAt: '2026-05-30T00:00:00Z',
    updatedAt: '2026-05-30T00:00:00Z',
    ...overrides,
  }
}

describe('computeRefetchInterval', () => {
  it('data 未定義時回傳 3000', () => {
    expect(computeRefetchInterval(undefined)).toBe(3000)
  })

  it('status = PENDING → 3000（等待 Bot 加入）', () => {
    expect(computeRefetchInterval(makeMeeting({ status: 'PENDING' }))).toBe(3000)
  })

  it('status = ACTIVE → 5000（偵測 ACTIVE → ENDED 轉換）', () => {
    expect(computeRefetchInterval(makeMeeting({ status: 'ACTIVE' }))).toBe(5000)
  })

  it('status = ENDED + summary = null → 5000（摘要生成中）', () => {
    expect(
      computeRefetchInterval(makeMeeting({ status: 'ENDED', summary: null }))
    ).toBe(5000)
  })

  it('status = ENDED + summary = "" → false（無內容，停止輪詢）', () => {
    expect(
      computeRefetchInterval(makeMeeting({ status: 'ENDED', summary: '' }))
    ).toBe(false)
  })

  it('status = ENDED + summary 有內容 → false（停止輪詢）', () => {
    expect(
      computeRefetchInterval(makeMeeting({ status: 'ENDED', summary: '本次會議討論了 Q3 目標' }))
    ).toBe(false)
  })

  it('status = FAILED → false（終止態，停止輪詢）', () => {
    expect(computeRefetchInterval(makeMeeting({ status: 'FAILED' }))).toBe(false)
  })
})
