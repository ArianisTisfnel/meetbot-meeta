import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { activeSessions } from './session-store.js'
import { resolveAnswer, sendChatBestEffort } from './wake-word-detector.js'
import { warmEouModel, isEndOfTurn } from '../lib/eou.js'
import type { MeetingSession } from '../types/session.js'

// livekit 時機層啟用時，啟動階段就下載/載入模型（首場會議不用付冷啟成本）。
if (env.INTERJECTION_ENABLED && env.INTERJECTION_TURN_DETECTOR === 'livekit') {
  warmEouModel()
}

/**
 * 主動插話引擎（interjection）— 讓蜜塔在沒被叫名字時也能「參與聊天」。
 *
 * 三層架構（各層可獨立替換）：
 *   ① 時機層：判斷「這一輪話講完了」。由 INTERJECTION_TURN_DETECTOR 選擇——
 *      - 'silence'：最後一段內容後 INTERJECTION_TURN_SILENCE_MS 無新內容即評估
 *      - 'livekit'：兩段式。先等 INTERJECTION_EOU_CHECK_MS（短），用 LiveKit
 *        turn-detector 模型（lib/eou.ts）判斷語意上「講完了嗎」：講完 → 立即評估
 *        （比死等快）；沒講完/模型不可用 → 退回在 SILENCE_MS 時無條件評估
 *        （長停頓覆蓋語意判斷，模型永遠只是增強不是依賴）。
 *   ② 決策層：Claude Haiku 以 rolling window 判斷「該不該插話、要回答什麼問題」。
 *      硬性防護（cooldown / 喚醒流程進行中 / bot 剛說過話）在呼叫模型前先擋掉。
 *   ③ 執行層：走既有 resolveAnswer（Dify RAG / 逐字稿 QA）取得答案，
 *      以**聊天室訊息**送出（主動插話用文字，比語音干擾低；語音留給喚醒詞問答）。
 *
 * 狀態存模組層 Map（keyed by meetingInstanceId），session 結束時由
 * session-manager 呼叫 {@link clearInterjection} 清理。
 */

export interface ConversationEntry {
  speaker: string
  text: string
  source: 'voice' | 'chat'
  fromBot: boolean
  at: number
}

const WINDOW_MAX_ENTRIES = 60
/** 決策模型一次看的對話則數。 */
const DECISION_CONTEXT_ENTRIES = 12
/** 喚醒詞問答進行中／剛結束時不插話的靜默期。 */
const WAKE_GRACE_MS = 15_000

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

interface InterjectionState {
  window: ConversationEntry[]
  lastInterjectionAt: number
  timer: ReturnType<typeof setTimeout> | null
  evaluating: boolean
}

const states = new Map<string, InterjectionState>()

function getOrCreateState(meetingInstanceId: string): InterjectionState {
  let s = states.get(meetingInstanceId)
  if (!s) {
    s = { window: [], lastInterjectionAt: 0, timer: null, evaluating: false }
    states.set(meetingInstanceId, s)
  }
  return s
}

/** session 結束時清理（session-manager 的 closeSession / handleSessionClose 呼叫）。 */
export function clearInterjection(meetingInstanceId: string): void {
  const s = states.get(meetingInstanceId)
  if (s?.timer) clearTimeout(s.timer)
  states.delete(meetingInstanceId)
}

/**
 * 每一段語音/聊天內容進來時呼叫（session-manager 的 onSegment / onChat）。
 * 累積 rolling window 並重排「turn 結束」計時器。
 */
export function recordConversation(session: MeetingSession, entry: ConversationEntry): void {
  if (!env.INTERJECTION_ENABLED) return

  const s = getOrCreateState(session.meetingInstanceId)
  s.window.push(entry)
  if (s.window.length > WINDOW_MAX_ENTRIES) s.window.splice(0, s.window.length - WINDOW_MAX_ENTRIES)

  if (s.timer) clearTimeout(s.timer)
  // bot 自己的訊息不該觸發「有人講完話」的評估
  if (entry.fromBot) return

  if (env.INTERJECTION_TURN_DETECTOR === 'livekit') {
    // 兩段式：短暫靜默後先問 EOU 模型，講完就提早評估
    s.timer = setTimeout(() => {
      s.timer = null
      checkEndOfTurn(session.meetingInstanceId).catch((err) =>
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'interjection: checkEndOfTurn error'),
      )
    }, env.INTERJECTION_EOU_CHECK_MS)
  } else {
    s.timer = setTimeout(() => {
      s.timer = null
      evaluateTurn(session.meetingInstanceId).catch((err) =>
        logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'interjection: evaluateTurn error'),
      )
    }, env.INTERJECTION_TURN_SILENCE_MS)
  }
}

/** livekit 時機層第一段：EOU 模型判斷「講完了嗎」；沒講完/不可用 → 排 fallback 評估。 */
async function checkEndOfTurn(meetingInstanceId: string): Promise<void> {
  const s = states.get(meetingInstanceId)
  if (!s || !s.window.length) return

  // 記住進入推論時的最後一則；推論期間有新內容 → 本次作廢（新內容自己的計時鏈會接手）
  const lastAt = s.window[s.window.length - 1].at

  const turns = s.window.slice(-DECISION_CONTEXT_ENTRIES).map((e) => ({
    role: (e.fromBot ? 'assistant' : 'user') as 'assistant' | 'user',
    content: e.text,
  }))
  const ended = await isEndOfTurn(turns, env.INTERJECTION_EOU_LANGUAGE, env.INTERJECTION_EOU_THRESHOLD)

  const s2 = states.get(meetingInstanceId)
  if (!s2 || !s2.window.length) return
  if (s2.window[s2.window.length - 1].at !== lastAt) return // 期間有新內容

  if (ended === true) {
    logger.info({ meetingInstanceId }, 'interjection: EOU model says turn ended, evaluating early')
    await evaluateTurn(meetingInstanceId)
    return
  }

  // 沒講完（或模型不可用）→ fallback：補滿剩餘靜默時間後無條件評估
  const remaining = Math.max(500, env.INTERJECTION_TURN_SILENCE_MS - env.INTERJECTION_EOU_CHECK_MS)
  if (s2.timer) clearTimeout(s2.timer)
  s2.timer = setTimeout(() => {
    s2.timer = null
    evaluateTurn(meetingInstanceId).catch((err) =>
      logger.error({ err, meetingInstanceId }, 'interjection: fallback evaluateTurn error'),
    )
  }, remaining)
}

/** ② 決策層＋③ 執行層。 */
async function evaluateTurn(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  const s = states.get(meetingInstanceId)
  if (!session || !session.botSession || !s || s.evaluating) return

  const now = Date.now()
  // 硬性防護：呼叫模型前先擋（省 token、避免搶話）
  if (session.isSpeaking) return
  if (now - session.lastWakeAt < WAKE_GRACE_MS) return
  if (session.wakePendingUntil > now) return
  if (now - s.lastInterjectionAt < env.INTERJECTION_COOLDOWN_MS) return
  const last = s.window[s.window.length - 1]
  if (!last || last.fromBot) return

  s.evaluating = true
  try {
    const recent = s.window.slice(-DECISION_CONTEXT_ENTRIES)
    const context = recent
      .map((e) => `[${e.fromBot ? '蜜塔(你)' : e.speaker || '參與者'}${e.source === 'chat' ? '·聊天室' : ''}] ${e.text}`)
      .join('\n')

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        '你是會議 AI 助理「蜜塔」的插話決策器。根據最近的對話判斷蜜塔現在是否應該主動補充。',
        '只有同時滿足以下條件才插話：',
        '1. 有人提出了明確的問題或資訊需求，且沒有指名要問某個人',
        '2. 這個問題看起來能靠會議資料或專案文件回答（事實型問題）',
        '3. 對話中沒有人正在回答它',
        '不確定就不插話。閒聊、意見交流、寒暄一律不插話。',
        '只回傳 JSON（不要 markdown）：{"interject": true/false, "question": "要幫忙回答的問題（interject 為 false 時給空字串）"}',
      ].join('\n'),
      messages: [{ role: 'user', content: `最近的對話：\n\n${context}` }],
    })

    const raw = message.content[0].type === 'text' ? message.content[0].text : ''
    let decision: { interject?: boolean; question?: string } = {}
    try {
      decision = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim())
    } catch {
      logger.warn({ meetingInstanceId, raw: raw.slice(0, 100) }, 'interjection: decision JSON parse failed')
      return
    }

    if (!decision.interject || !decision.question?.trim()) {
      logger.info({ meetingInstanceId }, 'interjection: decision = stay quiet')
      return
    }

    logger.info(
      { meetingInstanceId, question: decision.question.slice(0, 60) },
      'interjection: decision = interject, resolving answer',
    )

    const lastAtBeforeAnswer = s.window[s.window.length - 1]?.at
    const answer = await resolveAnswer(session, decision.question, 'chat')

    // 送出前最後一刻：查詢期間有人開口 → 讓路，放棄本次插話（不消耗冷卻）
    const nowLast = s.window[s.window.length - 1]
    if (nowLast && nowLast.at !== lastAtBeforeAnswer && !nowLast.fromBot) {
      logger.info({ meetingInstanceId }, 'interjection: someone spoke during answer resolution, yielding')
      return
    }

    s.lastInterjectionAt = Date.now()
    await sendChatBestEffort(session, `💡 ${answer}`)

    s.window.push({ speaker: '蜜塔', text: answer, source: 'chat', fromBot: true, at: Date.now() })
    logger.info({ meetingInstanceId, answerPreview: answer.slice(0, 60) }, 'interjection: answer sent to chat')
  } finally {
    s.evaluating = false
  }
}
