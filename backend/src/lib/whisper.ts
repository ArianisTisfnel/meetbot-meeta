import { env } from '../types/env.js'

/**
 * whisper-service（Breeze-ASR-25 會後重轉錄微服務）client。
 *
 * 服務可能跑在區網另一台 GPU 機器（WHISPER_SERVICE_URL 指定）；job store 在
 * 服務記憶體，重啟即失 → getTranscriptionJob 以 'gone' 表示 404，呼叫端重送。
 */

export interface WhisperSegment {
  text: string
  /** 秒（相對音檔開頭） */
  start: number
  end: number
}

export type WhisperJobResult =
  | { status: 'queued' | 'processing' }
  | { status: 'done'; segments: WhisperSegment[] }
  | { status: 'error'; error: string }
  /** job 不存在（whisper-service 重啟）：呼叫端應清掉 jobId 重送。 */
  | { status: 'gone' }

export function isWhisperConfigured(): boolean {
  return Boolean(env.WHISPER_SERVICE_URL)
}

export async function submitTranscriptionJob(audioUrl: string): Promise<string> {
  const res = await fetch(`${env.WHISPER_SERVICE_URL}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`whisper-service POST /jobs failed ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { job_id: string }
  return data.job_id
}

export async function getTranscriptionJob(jobId: string): Promise<WhisperJobResult> {
  const res = await fetch(`${env.WHISPER_SERVICE_URL}/jobs/${jobId}`)
  if (res.status === 404) return { status: 'gone' }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`whisper-service GET /jobs/${jobId} failed ${res.status}: ${text}`)
  }
  return (await res.json()) as WhisperJobResult
}
