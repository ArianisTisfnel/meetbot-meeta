/**
 * 蜜塔「主動插話／沉默破冰」的 prompt 定義（prompt engineering 專用檔）。
 *
 * 為什麼獨立成檔：
 *   1. 調 prompt 不必動引擎邏輯（interjection.ts），review diff 一眼可辨
 *   2. `scripts/eval-interjection.ts` 直接 import 同一份 prompt 做離線評測，
 *      保證「線上跑的」與「評測的」永遠是同一版，不會抄寫走鐘
 *
 * ⚠️ 修改字串前，先跑 `npx tsx --env-file .env scripts/eval-interjection.ts`
 *    取得現行版在劇本集上的基準，改完再跑一次比較。
 */

/** 對話窗單則的最小形狀（與 interjection.ts 的 ConversationEntry 結構相容）。 */
export interface ConversationEntryLike {
  speaker: string
  text: string
  source: 'voice' | 'chat'
  fromBot: boolean
}

/**
 * 對話窗 → 決策/破冰 prompt 用的文字格式。
 * 評測工具必須用與線上完全相同的格式，否則測的不是真實輸入分佈。
 * chatMarker：決策層會標「·聊天室」區分通道；破冰總結不標。
 */
export function formatConversation(
  entries: ConversationEntryLike[],
  opts: { chatMarker: boolean } = { chatMarker: true },
): string {
  return entries
    .map(
      (e) =>
        `[${e.fromBot ? '蜜塔(你)' : e.speaker || '參與者'}${
          opts.chatMarker && e.source === 'chat' ? '·聊天室' : ''
        }] ${e.text}`,
    )
    .join('\n')
}

/** ② 決策層 system prompt：判斷「該不該插話、要回答哪個問題」。 */
export const INTERJECTION_DECISION_SYSTEM = [
  '你是會議 AI 助理「蜜塔」的插話決策器。根據最近的對話判斷蜜塔現在是否應該主動補充。',
  '只有同時滿足以下條件才插話：',
  '1. 有人提出了明確的問題或資訊需求，且沒有指名要問某個人',
  '2. 這個問題看起來能靠會議資料或專案文件回答（事實型問題）',
  '3. 對話中沒有人（包括蜜塔自己）已經回答過它',
  '不確定就不插話。閒聊、意見交流、寒暄一律不插話。',
  'question 欄位規則：必須是「對話中某位參與者實際說出的問題」的原樣或忠實濃縮。',
  '絕對不可以填你想反問參與者的問題、不可自行發明或擴寫問題。',
  '若對方的問題太模糊、你需要反問才能釐清 → 直接 interject 給 false。',
  '只回傳 JSON（不要 markdown）：{"interject": true/false, "question": "（interject 為 false 時給空字串）"}',
].join('\n')

/** 沉默破冰（會議中已有討論）：總結進度＋拋出推進問題。 */
export const ICEBREAKER_SUMMARY_SYSTEM =
  '你是會議 AI 助理蜜塔。現場已沉默一段時間，請用一到兩句話總結目前討論到哪，再拋出一個能推進討論的具體問題。口語、繁體中文、60 字內。'

/** 開場破冰罐頭台詞（幾乎沒人講過話；免 LLM、快又穩）。 */
export const ICEBREAKER_OPENING_WITH_KB =
  '大家好像還沒開始討論～需要暖身的話，可以直接問我專案資料的問題，例如重要日期或規則，我都查得到喔。'
export const ICEBREAKER_OPENING_NO_KB =
  '大家好像還沒開始討論～有需要我幫忙的地方，隨時叫「蜜塔」就可以了。'
