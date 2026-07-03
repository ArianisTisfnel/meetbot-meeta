import Anthropic from '@anthropic-ai/sdk'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { activeSessions } from './session-store.js'
import { resolveAnswer, sendChatBestEffort } from './wake-word-detector.js'
import type { MeetingSession } from '../types/session.js'

/**
 * 主動插話引擎（interjection）— 讓蜜塔在沒被叫名字時也能「參與聊天」。
 *
 * 三層架構（各層可獨立替換）：
 *   ① 時機層（TurnDetector）：判斷「這一輪話講完了」。
 *      v1 = SilenceTurnDetector（最後一段內容後 N ms 無新內容）。
 *      預留掛載點：之後可換成 LiveKit turn-detector（開源 ONNX 文字模型，
 *      livekit/turn-detector，支援中文）——以對話窗算 end-of-utterance 機率，
 *      動態決定等待時間（高機率 → 縮短等待；低機率 → 拉長），實作新的
 *      TurnDetector 換掉預設即可，其餘層不動。
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

/** 時機層介面：回傳「最後一段內容後等多久沒新內容，就視為一輪結束」。 */
export interface TurnDetector {
  silenceThresholdMs(window: ConversationEntry[]): number
}

/** v1：固定停頓門檻。之後可換 LiveKit EOU 模型動態調整。 */
class SilenceTurnDetector implements TurnDetector {
  silenceThresholdMs(): number {
    return env.INTERJECTION_TURN_SILENCE_MS
  }
}

const turnDetector: TurnDetector = new SilenceTurnDetector()

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

  s.timer = setTimeout(() => {
    s.timer = null
    evaluateTurn(session.meetingInstanceId).catch((err) =>
      logger.error({ err, meetingInstanceId: session.meetingInstanceId }, 'interjection: evaluateTurn error'),
    )
  }, turnDetector.silenceThresholdMs(s.window))
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
    s.lastInterjectionAt = Date.now()

    const answer = await resolveAnswer(session, decision.question, 'chat')
    await sendChatBestEffort(session, `💡 ${answer}`)

    s.window.push({ speaker: '蜜塔', text: answer, source: 'chat', fromBot: true, at: Date.now() })
    logger.info({ meetingInstanceId, answerPreview: answer.slice(0, 60) }, 'interjection: answer sent to chat')
  } finally {
    s.evaluating = false
  }
}
