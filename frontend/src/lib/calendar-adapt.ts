/**
 * 後端 DTO ↔ 行事曆元件型別的轉換。
 *
 * 元件層用的是「畫得出來」的形狀（Date 物件、字串 id、小寫 rsvp），
 * API 用的是「傳得動」的形狀（ISO 字串、數字 userId、大寫 enum）。
 * 兩邊各自合理，所以在這裡轉一次，而不是讓其中一邊將就另一邊。
 */

import type { CalendarEvent, CalendarMember, RsvpStatus, TimeSlot } from './calendar'
import type {
  BusyBlockDto,
  CalendarMeetingDto,
  CalendarMemberDto,
  FreeSlotDto,
  RsvpStatus as RsvpDto,
} from '@/types/api'

const RSVP_MAP: Record<RsvpDto, RsvpStatus> = {
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined',
  PENDING: 'pending',
}

export function toMember(dto: CalendarMemberDto): CalendarMember {
  return {
    id: String(dto.userId),
    name: dto.name ?? dto.email,
    email: dto.email,
    syncState: dto.syncState,
  }
}

/**
 * 會議 DTO → 行事曆事件。
 *
 * 沒有排定時間的會議（例如直接「立刻開」而產生的舊資料）畫不到格線上，回 null 由呼叫端濾掉。
 */
export function toMeetingEvent(dto: CalendarMeetingDto): CalendarEvent | null {
  if (!dto.scheduledStartAt || !dto.scheduledEndAt) return null
  return {
    id: dto.id,
    kind: 'meeting',
    title: dto.name,
    start: new Date(dto.scheduledStartAt),
    end: new Date(dto.scheduledEndAt),
    attendees: dto.attendees.map((a) => ({
      memberId: String(a.userId),
      rsvp: RSVP_MAP[a.rsvp],
    })),
    projectId: dto.projectId ?? undefined,
    projectName: dto.projectName ?? undefined,
    canceled: dto.status === 'CANCELED',
    meetUrl: dto.googleMeetUrl || undefined,
    botAutoJoin: dto.botAutoJoin,
  }
}

/** 忙碌時段沒有標題（後端刻意不回），畫面上以擁有者的名字代替。 */
export function toBusyEvent(dto: BusyBlockDto, memberName?: string): CalendarEvent {
  return {
    id: dto.id,
    kind: 'busy',
    title: memberName ? `${memberName}・忙碌` : '忙碌',
    start: new Date(dto.startAt),
    end: new Date(dto.endAt),
    memberId: String(dto.userId),
  }
}

export function toSlot(dto: FreeSlotDto): TimeSlot {
  return { start: new Date(dto.start), end: new Date(dto.end) }
}
