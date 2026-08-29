'use client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type {
  CalendarMeetingDto,
  FreeSlotsResponse,
  GlobalCalendarResponse,
  ProjectCalendarResponse,
  RsvpStatus,
} from '@/types/api'

/**
 * 行事曆的資料存取。
 *
 * 查詢區間一律用 ISO 絕對時間送給後端（spec §5「所有計算以絕對時間為準」），
 * queryKey 也用同一組字串，換週就自動重抓。
 */

function rangeKey(from: Date, to: Date) {
  return `${from.toISOString()}_${to.toISOString()}`
}

export function useProjectCalendar(projectId: string, from: Date, to: Date) {
  return useQuery({
    queryKey: ['calendar', 'project', projectId, rangeKey(from, to)],
    queryFn: () =>
      apiClient.get<ProjectCalendarResponse>(
        `/projects/${projectId}/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      ),
    enabled: !!projectId,
  })
}

export function useGlobalCalendar(from: Date, to: Date) {
  return useQuery({
    queryKey: ['calendar', 'global', rangeKey(from, to)],
    queryFn: () =>
      apiClient.get<GlobalCalendarResponse>(
        `/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      ),
  })
}

export interface FreeSlotRequest {
  memberUserIds: number[]
  durationMin: number
  from: Date
  to: Date
  workStartHour?: number
  workEndHour?: number
  includeWeekends?: boolean
}

/**
 * 找共同空檔。用 mutation 而不是 query：它由使用者按下「搜尋」觸發，
 * 不該在切換成員勾選時自動重打。
 *
 * tzOffsetMinutes 由這裡補上——後端不猜使用者在哪一區，「上班時間 9–18 點」
 * 要換算成絕對時間就得知道偏移量。getTimezoneOffset() 是反號的，故取負值。
 */
export function useFindFreeSlots(projectId: string) {
  return useMutation({
    mutationFn: (req: FreeSlotRequest) =>
      apiClient.post<FreeSlotsResponse>(`/projects/${projectId}/calendar/free-slots`, {
        memberUserIds: req.memberUserIds,
        durationMin: req.durationMin,
        from: req.from.toISOString(),
        to: req.to.toISOString(),
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
        workStartHour: req.workStartHour ?? 9,
        workEndHour: req.workEndHour ?? 18,
        includeWeekends: req.includeWeekends ?? false,
      }),
  })
}

export interface ScheduleMeetingInput {
  name: string
  scheduledStartAt: Date
  scheduledEndAt: Date
  attendeeUserIds: number[]
  googleMeetUrl?: string
}

export function useScheduleMeeting(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleMeetingInput) =>
      apiClient.post<CalendarMeetingDto>(`/projects/${projectId}/calendar/meetings`, {
        name: input.name,
        scheduledStartAt: input.scheduledStartAt.toISOString(),
        scheduledEndAt: input.scheduledEndAt.toISOString(),
        // 建立者當下的時區，供 GCal 寫回與跨區顯示用
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attendeeUserIds: input.attendeeUserIds,
        googleMeetUrl: input.googleMeetUrl ?? null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar'] })
      // 會議列表也會多一筆 SCHEDULED
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
    },
  })
}

export function useRespondRsvp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ meetingId, rsvp }: { meetingId: string; rsvp: RsvpStatus }) =>
      apiClient.post<CalendarMeetingDto>(`/calendar/meetings/${meetingId}/rsvp`, { rsvp }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calendar'] }),
  })
}

export function useCancelScheduledMeeting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (meetingId: string) =>
      apiClient.post<CalendarMeetingDto>(`/calendar/meetings/${meetingId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar'] })
      queryClient.invalidateQueries({ queryKey: ['meetings'] })
    },
  })
}
