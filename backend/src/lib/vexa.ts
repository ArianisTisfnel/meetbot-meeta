import { env } from '../types/env.js'
import { AppError } from '../middleware/error-handler.js'
import type { VexaRestSegment } from '../types/session.js'

export class VexaConcurrentLimitError extends Error {
  constructor() {
    super('Vexa: maximum concurrent bot limit reached')
    this.name = 'VexaConcurrentLimitError'
  }
}

export function parseGoogleMeetUrl(url: string): string | null {
  const m = url.match(
    /meet\.google\.com\/((?:[a-z]{3}-[a-z]{4}-[a-z]{3})|(?:[a-z0-9][a-z0-9-]{3,38}[a-z0-9]))/,
  )
  return m ? m[1] : null
}

export async function inviteBot(params: {
  googleMeetUrl: string
  vexaToken: string
  botName?: string
  voiceAgentEnabled?: boolean
}): Promise<{ vexaMeetingId: number; nativeMeetingId: string }> {
  const nativeMeetingId = parseGoogleMeetUrl(params.googleMeetUrl)
  if (!nativeMeetingId) {
    throw new AppError('INVALID_REQUEST', 400, '無效的 Google Meet URL 格式')
  }

  const res = await fetch(`${env.VEXA_API_URL}/bots`, {
    method: 'POST',
    headers: {
      'X-API-Key': params.vexaToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meeting_url: params.googleMeetUrl,
      bot_name: params.botName ?? '蜜塔',
      voice_agent_enabled: params.voiceAgentEnabled ?? true,
    }),
  })

  if (res.status === 403) {
    throw new VexaConcurrentLimitError()
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Vexa inviteBot error ${res.status}: ${text}`)
  }

  const data = (await res.json()) as { id: number }
  return { vexaMeetingId: data.id, nativeMeetingId }
}

export async function removeBot(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
): Promise<void> {
  const res = await fetch(`${env.VEXA_API_URL}/bots/${platform}/${nativeMeetingId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': vexaToken },
  })

  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Vexa removeBot error ${res.status}: ${text}`,
    )
  }
}

export async function getTranscriptions(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
): Promise<VexaRestSegment[]> {
  const res = await fetch(`${env.VEXA_API_URL}/transcripts/${platform}/${nativeMeetingId}`, {
    headers: { 'X-API-Key': vexaToken },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError(
      'EXTERNAL_SERVICE_ERROR',
      503,
      `Vexa getTranscriptions error ${res.status}: ${text}`,
    )
  }

  return res.json() as Promise<VexaRestSegment[]>
}

export async function speak(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
  params: { text: string; provider: string; voice: string },
): Promise<void> {
  const res = await fetch(`${env.VEXA_API_URL}/bots/${platform}/${nativeMeetingId}/speak`, {
    method: 'POST',
    headers: { 'X-API-Key': vexaToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Vexa speak error ${res.status}: ${text}`)
  }
}

export async function chatSend(
  platform: string,
  nativeMeetingId: string,
  vexaToken: string,
  params: { text: string },
): Promise<void> {
  const res = await fetch(`${env.VEXA_API_URL}/bots/${platform}/${nativeMeetingId}/chat`, {
    method: 'POST',
    headers: { 'X-API-Key': vexaToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Vexa chatSend error ${res.status}: ${text}`)
  }
}
