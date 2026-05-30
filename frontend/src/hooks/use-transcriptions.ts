'use client'
import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { TranscriptSegment, TranscriptResponse } from '@/types/api'

/**
 * 建立逐字稿查詢 URL（純函式，供測試使用）
 */
export function buildTranscriptUrl(
  basePath: string,
  sinceStartTime: number | null
): string {
  return sinceStartTime !== null
    ? `${basePath}?since_start_time=${sinceStartTime}`
    : basePath
}

/**
 * 套用新 segments 到現有 Map，以 segmentId 去重（純函式，供測試使用）
 * segmentId 為 null 時退而用 `${startTime}-${text}` 作 key
 */
export function applySegmentsToMap(
  prev: Map<string, TranscriptSegment>,
  segments: TranscriptSegment[]
): Map<string, TranscriptSegment> {
  const next = new Map(prev)
  for (const seg of segments) {
    const key = seg.segmentId ?? `${seg.startTime}-${seg.text}`
    next.set(key, seg)
  }
  return next
}

/**
 * 取得下一個游標（純函式，供測試使用）
 * cursor = 最後一個 segment 的 startTime（float）
 */
export function getNextCursor(segments: TranscriptSegment[]): number | null {
  if (segments.length === 0) return null
  return segments.at(-1)!.startTime
}

/**
 * 進行中會議的即時逐字稿輪詢
 * 使用 Map upsert 去重，cursor 為 since_start_time（float）
 */
export function useLiveTranscriptions(
  projectId: string | null,
  meetingId: string,
  isActive: boolean
) {
  const [sinceStartTime, setSinceStartTime] = useState<number | null>(null)
  const [segmentMap, setSegmentMap] = useState<Map<string, TranscriptSegment>>(
    new Map()
  )

  const basePath = projectId
    ? `/projects/${projectId}/meetings/${meetingId}/transcriptions`
    : `/meetings/${meetingId}/transcriptions`

  useQuery({
    queryKey: ['transcriptions-live', meetingId, sinceStartTime],
    queryFn: async () => {
      const url = buildTranscriptUrl(basePath, sinceStartTime)
      const res = await apiClient.get<TranscriptResponse>(url)
      if (res.items.length > 0) {
        setSegmentMap((prev) => applySegmentsToMap(prev, res.items))
        setSinceStartTime(getNextCursor(res.items))
      }
      return res
    },
    enabled: isActive,
    refetchInterval: 3000,
  })

  return useMemo(
    () =>
      [...segmentMap.values()].sort((a, b) => a.startTime - b.startTime),
    [segmentMap]
  )
}

export function useTranscriptions(
  projectId: string | null,
  meetingId: string
) {
  const basePath = projectId
    ? `/projects/${projectId}/meetings/${meetingId}/transcriptions`
    : `/meetings/${meetingId}/transcriptions`

  return useQuery({
    queryKey: ['transcriptions', meetingId],
    queryFn: () => apiClient.get<TranscriptResponse>(basePath),
    enabled: !!meetingId,
  })
}
