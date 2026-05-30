import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import * as vexaClient from '../lib/vexa.js'
import * as dify from '../lib/dify.js'
import type { MeetingSession, VexaChatMessage } from '../types/session.js'

const WAKE_WORD_REGEX = /[蜜密祕秘迷][塔搭]|小幫手|[Mm]eeta|[Mm]ita/
const DEBOUNCE_MS = 2000
const MAX_PROCESSED_SEGMENT_IDS = 5000
const CONVERSATION_IDLE_RESET_MS = 5 * 60 * 1000

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

// ── 語音輸入 ───────────────────────────────────────────────────────────────────

export async function handleTranscriptSegment(
  session: MeetingSession,
  segment: { segment_id: string; text: string; speaker: string; start_time: number; end_time: number },
): Promise<void> {
  if (!segment.segment_id || session.processedSegmentIds.has(segment.segment_id)) return

  if (session.processedSegmentIds.size >= MAX_PROCESSED_SEGMENT_IDS) {
    const ids = [...session.processedSegmentIds]
    session.processedSegmentIds = new Set(ids.slice(Math.floor(ids.length / 2)))
  }
  session.processedSegmentIds.add(segment.segment_id)

  const match = WAKE_WORD_REGEX.exec(segment.text)
  if (!match) return

  const now = Date.now()
  if (now - session.lastWakeAt < DEBOUNCE_MS) return
  session.lastWakeAt = now

  const question = segment.text
    .slice(match.index + match[0].length)
    .replace(/^[\s，。！？、…]+/, '')
    .trim()
  if (!question) return

  await dispatchQuestion(session, question, 'voice')
}

// ── 聊天室輸入 ─────────────────────────────────────────────────────────────────

export async function handleChatMessage(
  session: MeetingSession,
  chatMsg: VexaChatMessage,
): Promise<void> {
  if (chatMsg.is_from_bot) return

  const match = WAKE_WORD_REGEX.exec(chatMsg.text)
  if (!match) return

  const now = Date.now()
  if (now - session.lastWakeAt < DEBOUNCE_MS) return
  session.lastWakeAt = now

  const question = chatMsg.text
    .slice(match.index + match[0].length)
    .replace(/^[\s，。！？、…]+/, '')
    .trim()
  if (!question) return

  await dispatchQuestion(session, question, 'chat')
}

// ── 問答路由 ───────────────────────────────────────────────────────────────────

async function resolveAnswer(
  session: MeetingSession,
  question: string,
  mode: 'voice' | 'text',
): Promise<string> {
  if (!session.difyDatasetId) {
    const { answer } = await answerFromTranscript(session, question)
    return answer
  }

  if (session.lastQuestionAt > 0 && Date.now() - session.lastQuestionAt > CONVERSATION_IDLE_RESET_MS) {
    logger.info({ meetingInstanceId: session.meetingInstanceId }, 'Dify conversation reset: idle timeout')
    session.difyConversationId = null
  }

  const callDify = (conversationId: string | null) =>
    dify.askQuestion({
      datasetId: session.difyDatasetId!,
      question,
      mode,
      userId: session.meetingInstanceId,
      conversationId,
    })

  try {
    const { answer, conversationId } = await callDify(session.difyConversationId)
    session.difyConversationId = conversationId || session.difyConversationId
    session.lastQuestionAt = Date.now()
    return answer
  } catch (err) {
    if (session.difyConversationId) {
      logger.warn({ meetingInstanceId: session.meetingInstanceId }, 'Dify error, resetting conversation and retrying')
      session.difyConversationId = null
      const { answer, conversationId } = await callDify(null)
      session.difyConversationId = conversationId
      session.lastQuestionAt = Date.now()
      return answer
    }
    throw err
  }
}

async function dispatchQuestion(
  session: MeetingSession,
  question: string,
  source: 'voice' | 'chat',
): Promise<void> {
  const pendingVoice = session.difyDatasetId
    ? '好的，我收到了，正在查詢資料，請稍候。'
    : '好的，我收到了，正在查閱會議記錄，請稍候。'
  const pendingChat = session.difyDatasetId
    ? '收到你的問題，正在查詢資料中……'
    : '收到你的問題，正在查閱會議記錄……'

  if (source === 'voice') {
    if (session.isSpeaking) return
    const promptEstimatedMs = Math.max(3000, (pendingVoice.length / 4) * 1000 + 1500)
    session.isSpeaking = true
    const lockTimer = setTimeout(() => { session.isSpeaking = false }, promptEstimatedMs + 10_000)

    try {
      await vexaClient.speak(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
        text: pendingVoice,
        provider: 'openai',
        voice: 'alloy',
      })

      const rawAnswer = await resolveAnswer(session, question, 'voice')

      let answer = rawAnswer
      if (rawAnswer.length > 100) {
        const truncated = rawAnswer.slice(0, 100)
        const lastPunct = truncated.search(/[。！？…][^。！？…]*$/)
        answer = (lastPunct > 0 ? truncated.slice(0, lastPunct + 1) : truncated) + '……如果想了解更多，可以繼續問我。'
      }

      clearTimeout(lockTimer)
      const answerEstimatedMs = Math.max(3000, (answer.length / 4) * 1000 + 1500)
      setTimeout(() => { session.isSpeaking = false }, promptEstimatedMs + answerEstimatedMs)

      await vexaClient.speak(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
        text: answer,
        provider: 'openai',
        voice: 'alloy',
      })
    } catch (err) {
      clearTimeout(lockTimer)
      session.isSpeaking = false
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion voice failed')
    }
  } else {
    await vexaClient.chatSend(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
      text: pendingChat,
    })

    try {
      const answer = await resolveAnswer(session, question, 'text')
      await vexaClient.chatSend(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
        text: answer,
      })
    } catch (err) {
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'dispatchQuestion chat failed')
      await vexaClient.chatSend(session.platform, session.nativeMeetingId, session.creatorVexaToken, {
        text: '抱歉，查詢時發生錯誤，請稍後再試。',
      })
    }
  }
}

// ── 逐字稿 Q&A（無知識庫路徑）─────────────────────────────────────────────────

async function answerFromTranscript(
  session: MeetingSession,
  question: string,
): Promise<{ answer: string }> {
  const allSegments = await vexaClient.getTranscriptions(
    session.platform,
    session.nativeMeetingId,
    session.creatorVexaToken,
  )
  const recentSegments = allSegments.slice(-30)
  if (!recentSegments.length) {
    return { answer: '目前還沒有足夠的逐字稿內容可以回答，請稍後再試。' }
  }
  const context = recentSegments
    .map((seg) => `[${seg.speaker || '參與者'}]: ${seg.text}`)
    .join('\n')

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: '你是在線的 AI 會議助理蜜塔（Meeta）。請根據提供的會議逐字稿片段，簡潔回答問題。若逐字稿沒有相關資訊，請說明無法從當前會議內容找到答案。',
    messages: [
      {
        role: 'user',
        content: `以下是近期的會議逐字稿片段：\n\n${context}\n\n請回答：${question}`,
      },
    ],
  })
  const answer = message.content[0].type === 'text' ? message.content[0].text : '抱歉，無法取得回答。'
  return { answer }
}
