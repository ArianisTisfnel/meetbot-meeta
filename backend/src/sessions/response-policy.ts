/**
 * 語意定址裁決層——只處理規則分不出來的灰色地帶。
 *
 * 分工（成本設計是重點，Gemini 免費層是全系統的阿基里斯腱）：
 *   句首呼喚「蜜塔，X」  → addressing.ts 純規則定案，**不進本檔**，零成本零延遲
 *   句中提及「我覺得蜜塔X」→ 進本檔，一次便宜的 LLM 呼叫判「對她說 vs 談論她」
 *   完全沒提到名字的追問  → 由插話決策層在 turn 結束時處理（interjection.ts）
 *
 * 為什麼句中提及非得靠語意：表面特徵完全分不出這兩句——
 *   「蜜塔這個功能是不是有點難做」→ 在跟同事討論蜜塔（不該回應）
 *   「那我問一下蜜塔，這個功能難做嗎」→ 在問蜜塔（該回應）
 * 兩句都含喚醒詞、都是疑問句、都有「這個功能」。差別只在誰是受話者。
 *
 * ⚠️ 改本檔的 prompt 前後都要跑：
 *   npx tsx --env-file .env scripts/eval-meeting.ts --address
 */
import { completeText } from '../lib/llm.js'
import { logger } from '../middleware/logger.js'
import type { ConversationEntryLike } from './interjection-prompts.js'
import { formatConversation } from './interjection-prompts.js'

/** 判定結果。unknown = 呼叫失敗，由呼叫端決定退回哪一邊。 */
export type AddressVerdict = 'address' | 'mention' | 'unknown'

export const ADDRESS_ARBITER_SYSTEM = [
  '你在判斷一句會議發言的「受話者」。會議裡有一位 AI 助理叫「蜜塔」（英文 Meeta）。',
  '這句話裡提到了蜜塔。請判斷說話者是「在對蜜塔說話」還是「在跟其他人談論蜜塔」。',
  '',
  '只回傳一個詞：',
  'address = 在對蜜塔說話（向她提問、請她做事、跟她打招呼）',
  'mention = 在談論蜜塔這個人／這個功能，受話者是其他與會者',
  '',
  '判斷要點：',
  '- 「蜜塔」後面直接接名詞或的字結構（蜜塔這個功能、蜜塔的回應、蜜塔的判斷）→ 蜜塔是被討論的主題 → mention',
  '- 句子在評論蜜塔（很怪、太死板、做得不錯、有點難做）→ mention',
  '- 轉述蜜塔說過的話並向他人求證（蜜塔剛才說X對吧、蜜塔不是說過X嗎）→ mention',
  '- 句子是對蜜塔下指令或直接問她（蜜塔幫我查、我問一下蜜塔X是什麼）→ address',
  '- 「蜜塔」後面緊接第二人稱「你」，且那個「你」指的是蜜塔 → address',
  '- 打招呼、問候、確認她在不在、問她是誰（蜜塔你好、蜜塔在嗎、蜜塔早安、hello 蜜塔、蜜塔你是誰）→ address。',
  '  這類話沒有第三方受話者可言——沒有人會跟同事說「蜜塔你好」來談論蜜塔。',
  '- 以上規則都套不上、真的無法判斷時才回 mention：沒被叫卻插嘴，比漏答一次更傷會議體驗。',
  '',
  '範例：',
  '「我覺得蜜塔這個功能是不是有點難做啊」→ mention',
  '「對啊，蜜塔現在的判斷太死板了」→ mention',
  '「剛剛那個 Meeta 的回應真的很怪」→ mention',
  '「蜜塔剛才說截止日是六月三十號對吧」→ mention',
  '「蜜塔的摘要要記得存檔」→ mention',
  '「蜜塔你好」→ address',
  '「蜜塔在嗎」→ address',
  '「蜜塔你是誰啊」→ address',
  '「小幫手請問報名日期」→ address',
  '「那我問一下蜜塔，報名截止日是什麼時候」→ address',
  '「欸我們叫蜜塔查一下好了，蜜塔你可以查嗎」→ address',
].join('\n')

/**
 * 裁決一句「句中提及蜜塔」的發言。
 * 帶近期對話當脈絡：同一段討論串裡的第二句提及，多半延續前一句的性質。
 */
export async function arbitrateAddress(params: {
  text: string
  speaker: string
  /** 近期對話窗（不含本句），提供受話者線索。 */
  recent: ConversationEntryLike[]
}): Promise<AddressVerdict> {
  const context = params.recent.length
    ? `最近的對話：\n${formatConversation(params.recent, { chatMarker: false })}\n\n`
    : ''
  try {
    const raw = await completeText({
      system: ADDRESS_ARBITER_SYSTEM,
      prompt: `${context}要判斷的這一句（說話者：${params.speaker || '未知'}）：\n${params.text}`,
      maxTokens: 10,
      temperature: 0, // 判定要穩定：同一句必須永遠同一個結果
      purpose: 'interjection',
    })
    return parseVerdict(raw)
  } catch (err) {
    logger.warn({ err }, 'arbitrateAddress failed')
    return 'unknown'
  }
}

/** 寬鬆解析裁決輸出。純函式，可測。 */
export function parseVerdict(raw: string): AddressVerdict {
  const t = raw.toLowerCase()
  if (t.includes('address') || t.includes('對蜜塔說') || t.includes('提問')) return 'address'
  if (t.includes('mention') || t.includes('談論') || t.includes('討論')) return 'mention'
  return 'unknown'
}
