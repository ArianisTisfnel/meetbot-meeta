'use client'
import { useEffect, useRef } from 'react'
import { useLiveTranscriptions } from '@/hooks/use-transcriptions'

interface Props {
  projectId: string | null
  meetingId: string
  isActive: boolean
}

/** 同一說話者、間隔 ≤ 8 秒的連續片段合併成一行（STT 常把一句話切成多個細碎片段）。 */
function mergeConsecutive<T extends { speaker: string | null; text: string; startTime: number; endTime: number }>(
  segments: T[],
): T[] {
  const out: T[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (prev && (prev.speaker ?? '') === (seg.speaker ?? '') && seg.startTime - prev.endTime <= 8) {
      prev.text = `${prev.text} ${seg.text}`.trim()
      prev.endTime = Math.max(prev.endTime, seg.endTime)
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

export function LiveTranscript({ projectId, meetingId, isActive }: Props) {
  const rawSegments = useLiveTranscriptions(projectId, meetingId, isActive)
  const segments = mergeConsecutive(rawSegments)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [rawSegments.length]) // 用合併前的數量：合併後行數不變但內容仍在增長時也要跟捲

  if (segments.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        等待逐字稿…
      </div>
    )
  }

  return (
    <div className="space-y-2 max-h-96 overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-muted-foreground">即時逐字稿</span>
        {isActive && (
          <span className="text-xs text-green-600 animate-pulse">自動更新中 🔄</span>
        )}
      </div>
      {segments.map((seg, i) => (
        <div key={i} className="text-sm">
          <span className="text-muted-foreground mr-2">
            {Math.floor(seg.startTime / 60)}:{String(Math.floor(seg.startTime % 60)).padStart(2, '0')}
          </span>
          <span className="font-medium mr-2">
            [{seg.speaker ?? '參與者'}]
          </span>
          <span>{seg.text}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
