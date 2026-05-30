import type { WebSocket } from 'ws'

/**
 * Vexa REST API GET /transcripts/{platform}/{native_id} 回傳的 segment 格式。
 * 欄位名為 start/end（Pydantic alias），非 start_time/end_time。
 */
export interface VexaRestSegment {
  segment_id: string | null
  text: string
  speaker: string | null
  start: number
  end: number
  language: string | null
  completed?: boolean
}

/**
 * va:meeting:{id}:chat channel 的 chat.new_message payload。
 */
export interface VexaChatMessage {
  sender: string
  text: string
  timestamp: number
  is_from_bot: boolean
}

export interface MeetingSession {
  meetingInstanceId: string
  vexaMeetingId: number
  platform: string
  nativeMeetingId: string
  difyDatasetId: string | null
  creatorVexaToken: string
  isSpeaking: boolean
  lastWakeAt: number
  processedSegmentIds: Set<string>
  wsConnection: WebSocket | null
  difyConversationId: string | null
  lastQuestionAt: number
}
