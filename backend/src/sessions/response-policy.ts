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
 *   npx tsx --env-file .env scripts/eval-meeting.ts --address --intent
 *   npx tsx --env-file .env scripts/eval-interjection.ts --variant live
 */
import { completeText } from '../lib/llm.js'
import { logger } from '../middleware/logger.js'
import { WAKE_WORD_REGEX } from './addressing.js'
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
  /**
   * false＝這次判斷是真的解析出來的；true＝呼叫例外或 JSON 解析失敗，其餘欄位都是保守預設值，
   * 不是模型的真實分類。只給觀測/評測用，**不影響任何路由或退回邏輯**——那些邏輯繼續照 addressed
   * 走（見上面 AddressVerdict 的說明）。不能單靠 `addressed === 'unknown'` 推斷這件事：schema
   * 的 addressed enum 沒有 'unknown' 這個值，正常情況下不會走到字串比對退回那條路，
   * 這裡直接在兩個失敗出口各自標記，不依賴那個巧合的耦合。
   */
  failed: boolean
}

/** 呼叫失敗時的中性結果：定址 unknown（呼叫端自行退回），其餘一律最保守。 */
const FAILED_DECISION: TurnDecision = {
  addressed: 'unknown',
  question: '',
  intent: 'factual',
  interject: false,
  failed: true,
}

/**
 * TurnDecision 的 JSON schema（小寫 JSON Schema；llm.ts 呼叫 Gemini 時會自動轉大寫）。
 * 交給 completeText 的 responseSchema 在 API 層強制輸出形狀與列舉值，
 * 取代原本寫在 TURN_DECISION_SYSTEM 裡「只回傳 JSON」的文字指示——
 * 格式描述留在這裡，欄位語意（怎麼判斷）仍在 prompt 裡，兩者不重複。
 */
const TURN_DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    addressed: {
      type: 'string',
      enum: ['address', 'mention', 'none'],
      description: '最後一則是不是在對蜜塔說話',
    },
    question: {
      type: 'string',
      description: '要回答的問題，忠實取自對話原文；沒有就是空字串',
    },
    intent: {
      type: 'string',
      enum: ['chitchat', 'factual', 'context', 'hybrid'],
      description: '這個問題該去哪裡找答案',
    },
    interject: {
      type: 'boolean',
      description: '沒人叫蜜塔時，現在主動補充恰不恰當',
    },
  },
  required: ['addressed', 'question', 'intent', 'interject'],
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
      responseSchema: TURN_DECISION_SCHEMA,
    })
    return parseTurnDecision(raw)
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
    failed: false,
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
