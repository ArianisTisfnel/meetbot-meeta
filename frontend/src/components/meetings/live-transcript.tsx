'use client'
import { useEffect, useRef } from 'react'
import { useLiveTranscriptions } from '@/hooks/use-transcriptions'

interface Props {
  projectId: string | null
  meetingId: string
  isActive: boolean
}

export function LiveTranscript({ projectId, meetingId, isActive }: Props) {
  const segments = useLiveTranscriptions(projectId, meetingId, isActive)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments.length])

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
