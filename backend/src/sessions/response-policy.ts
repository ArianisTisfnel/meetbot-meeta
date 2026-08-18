/**
 * 語意決策層——規則層分不出來的事，一律在這裡用**一次** LLM 呼叫決定。
 *
 * 分工（成本設計是重點，Gemini 免費層是全系統的阿基里斯腱）：
 *   句首呼喚「蜜塔，X」  → addressing.ts 純規則定案「該回應」，零成本零延遲；
 *                          本檔只再補一個 intent（取代舊的 classifyIntent，呼叫數不變）
 *   句中提及「我覺得蜜塔X」→ 本檔判「對她說 vs 談論她」＋順手拿到 intent（舊制要打兩次）
 *   沒喊名字的連續追問     → 本檔判「這是不是在延續剛才問我的那一串」（回報 A.3）
 *   完全沒人叫、也不是追問 → 本檔判「該不該主動補充」（插話決策，interjection.ts 用）
 *
 * 為什麼四件事合成一次呼叫，見 interjection-prompts.ts 的 TURN_DECISION_SYSTEM 說明。
 *
 * ⚠️ 改本檔或那份 prompt 前後都要跑：
 *   npx tsx --env-file .env scripts/eval-meeting.ts --address
 *   npx tsx --env-file .env scripts/eval-interjection.ts --variant live
 */
import { completeText } from '../lib/llm.js'
import { logger } from '../middleware/logger.js'
import { WAKE_WORD_REGEX, stripLeadingPunct } from './addressing.js'
import type { AnswerRoute } from './reply-tags.js'
import type { ConversationEntryLike } from './interjection-prompts.js'
import { formatConversation, TURN_DECISION_SYSTEM } from './interjection-prompts.js'

/**
 * 定址判定。`unknown` = 呼叫失敗，**由呼叫端決定退回哪一邊**——
 * 兩個呼叫端的安全方向相反，不可以在本檔統一決定：
 *   句中提及（有喊名字）→ 退回「照常回答」。判不出來絕不能等同「沒在叫我」，
 *     否則額度一枯竭蜜塔就對所有非逗號句型全聾。
 *   連續追問（沒喊名字）→ 退回「安靜」。這裡若退回照常回答，額度枯竭時
 *     蜜塔會把會議中每一句話都當成在問她，是災難等級的誤觸發。
 */
export type AddressVerdict = 'address' | 'mention' | 'none' | 'unknown'

// ── 意圖四分類 ────────────────────────────────────────────────────────────────
// 定義放本檔（而非 wake-word-detector）的理由：intent 現在是語意決策層的產出之一，
// 與定址/插話同一次呼叫得到。wake-word-detector 仍 re-export，呼叫端與測試不用改。
//
//   chitchat：寒暄/閒聊（你好嗎、謝謝）→ LLM 直答，完全不碰 Dify 與逐字稿
//   factual ：查文件就能答（報名日期）→ Dify RAG（原路）
//   context ：意見/脈絡型（你覺得如何）→ LLM＋近期逐字稿
//   hybrid  ：兩者都要（依簡章看我們時程合理嗎）→ 先 Dify 檢索、再與脈絡合成

export type QuestionIntent = 'chitchat' | 'factual' | 'context' | 'hybrid'

/** 把分類器輸出解析成意圖（寬鬆比對；未知回 factual）。純函式，可測。 */
export function parseIntent(raw: string): QuestionIntent {
  const t = raw.toLowerCase()
  if (t.includes('chitchat') || t.includes('閒聊') || t.includes('寒暄')) return 'chitchat'
  if (t.includes('hybrid') || t.includes('混合')) return 'hybrid'
  if (t.includes('context') || t.includes('意見') || t.includes('脈絡')) return 'context'
  return 'factual'
}

/**
 * 意圖 → 實際走的資料來源。**路由的唯一真相**：resolveAnswerRouted 與
 * scripts/eval-meeting.ts 都用這一份，避免評測跟線上判不一樣。
 */
export function routeForIntent(intent: QuestionIntent, hasKb: boolean): AnswerRoute {
  if (!hasKb) return 'transcript'
  if (intent === 'chitchat') return 'chitchat'
  if (intent === 'context') return 'transcript'
  return 'rag' // factual / hybrid 都要先做 Dify 檢索
}

// ── 每輪語意決策 ──────────────────────────────────────────────────────────────

export interface TurnDecision {
  /** 最後一則是不是在對蜜塔說話。 */
  addressed: AddressVerdict
  /** 要回答的問題（忠實擷取自對話；沒有就是空字串）。 */
  question: string
  /** 這個問題該去哪裡找答案。 */
  intent: QuestionIntent
  /** 沒人叫蜜塔的前提下，現在主動補充恰不恰當（插話引擎用）。 */
  interject: boolean
}

/** 呼叫失敗時的中性結果：定址 unknown（呼叫端自行退回），其餘一律最保守。 */
const FAILED_DECISION: TurnDecision = {
  addressed: 'unknown',
  question: '',
  intent: 'factual',
  interject: false,
}

/**
 * 對「剛講完的這一輪」做一次語意決策。
 *
 * window 的**最後一則必須是要判斷的那一句**（格式與插話決策層完全相同，
 * 這樣 eval-interjection.ts 的劇本與線上輸入分佈一致）。
 */
export async function decideTurn(params: {
  window: ConversationEntryLike[]
  /** 知識庫內容卡：讓 intent 知道知識庫實際有什麼，別把查不到的事實題硬分成 factual。 */
  kbContentCard?: string | null
}): Promise<TurnDecision> {
  const kb = params.kbContentCard
    ? `\n\n知識庫目前的文件與內容摘要：\n${params.kbContentCard}`
    : ''
  try {
    const raw = await completeText({
      system: TURN_DECISION_SYSTEM,
      prompt: `最近的對話：\n\n${formatConversation(params.window, { chatMarker: true })}${kb}`,
      maxTokens: 200,
      temperature: 0, // 判定要穩定：同一段對話必須永遠同一個結果
      purpose: 'interjection',
    })
    return dropQuestionCopiedFromEarlierEntry(parseTurnDecision(raw), params.window)
  } catch (err) {
    logger.warn({ err }, 'decideTurn failed')
    return FAILED_DECISION
  }
}

/**
 * 寬鬆解析決策輸出。純函式，可測。
 * 解析不出 JSON 時回 FAILED_DECISION——這與呼叫失敗同義（拿不到判斷），
 * 讓兩個呼叫端各自的退回策略一體適用，不必分辨「沒回應」與「回了看不懂的東西」。
 */
export function parseTurnDecision(raw: string): TurnDecision {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim())
  } catch {
    logger.warn({ raw: raw.slice(0, 120) }, 'parseTurnDecision: JSON parse failed')
    return FAILED_DECISION
  }
  const addressedRaw = String(obj.addressed ?? '').toLowerCase()
  const addressed: AddressVerdict =
    addressedRaw.includes('address') || addressedRaw.includes('對蜜塔說')
      ? 'address'
      : addressedRaw.includes('mention') || addressedRaw.includes('談論') || addressedRaw.includes('討論')
        ? 'mention'
        : addressedRaw.includes('none') || addressedRaw.includes('沒有')
          ? 'none'
          : 'unknown'
  return {
    addressed,
    question: meaningfulQuestion(typeof obj.question === 'string' ? obj.question.trim() : ''),
    intent: parseIntent(String(obj.intent ?? '')),
    interject: obj.interject === true,
  }
}

/** 只剩喚醒詞與標點的字串（拆掉之後什麼都不剩）。 */
const WAKE_WORD_ONLY_REGEX = new RegExp(
  `^(?:${WAKE_WORD_REGEX.source}|[\\s，。！？、…,.!?;:；：~～\\-—])+$`,
)

/**
 * 只喊了名字不算問題。
 *
 * 實測 2026-07-29：對話窗是「[Arianis] 蜜塔」＋「[小華] 我先去倒杯水」時，模型會判
 * addressed=address 並把前一則的「蜜塔」當成本輪要回答的問題——於是有人叫了一聲名字、
 * 別人接著講不相干的事，蜜塔就拿「蜜塔」兩個字去查知識庫。
 *
 * prompt 那側已寫明「question 一定要取自最後一則」，這裡是結構性的第二道防線：
 * 放在解析層（而不是某一條呼叫路徑裡），線上與離線評測就不會只有一邊擋得住。
 */
function meaningfulQuestion(question: string): string {
  return question && WAKE_WORD_ONLY_REGEX.test(question) ? '' : question
}

/**
 * `addressed=address` 時，question 只能取自**最後一則**（prompt ② 段的規則）。
 *
 * 實測 2026-08-18：長會議裡蜜塔被叫過很多次時，模型會把**前面某一則**的問題原封不動搬過來
 * 當成本輪要回答的題目——最後一則明明只是「等一下」這種 STT 半句，卻配上第一則的
 * 「蜜塔，剛才誰在講資料庫搬遷」送去檢索。prompt 那側已寫明取材範圍、加了反例、
 * 也加了機械式的 `lastLineIsFiller` 閘門，命中率上去了但壓不到零（temperature 已經是 0）。
 *
 * 與上面的 {@link meaningfulQuestion} 同一個設計：**一定成立的約束放到解析後的結構層**，
 * 線上與離線評測才不會只有一邊擋得住。兩個刻意的窄化：
 *   1. 只認**逐字相同**，不碰忠實濃縮——prompt 允許濃縮，收太寬會誤殺正常回答；
 *   2. **只在 addressed=address 時生效**——插話那個出口本來就該去撿前面沒人回答的問題
 *      （見 TURN_DECISION_SYSTEM ② 段：兩個出口的取材範圍相反）。
 *
 * 抹成空字串而不是改判 none 是刻意的：兩個呼叫端都寫成「判 address 卻擷不出問題就閉嘴」，
 * 沿用那條既有路徑，不必在本檔重複決定退回方向。
 */
export function dropQuestionCopiedFromEarlierEntry(
  decision: TurnDecision,
  window: ConversationEntryLike[],
): TurnDecision {
  if (decision.addressed !== 'address' || !decision.question || window.length < 2) return decision

  const norm = (s: string) => stripLeadingPunct(s).trim()
  const question = norm(decision.question)
  if (!question) return decision

  // 最後一則本身就包含這個問題 → 合法（含有人重複講同一句話的情形），不動。
  const last = norm(window[window.length - 1]?.text ?? '')
  if (last && last.includes(question)) return decision

  const copied = window.slice(0, -1).some((entry) => {
    const text = norm(entry.text)
    if (!text) return false
    // 前面那一則可能帶著喚醒詞（「蜜塔，剛才誰在講X」），剝掉再比一次
    return text === question || norm(text.replace(WAKE_WORD_REGEX, '')) === question
  })
  if (!copied) return decision

  logger.warn(
    { question: decision.question.slice(0, 60) },
    'decideTurn: question copied verbatim from an earlier entry -> dropped (see prompt ② 取材範圍)',
  )
  return { ...decision, question: '' }
}
