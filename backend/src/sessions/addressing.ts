/**
 * 定址判斷（addressing）——「這句話是不是在對蜜塔說話？」
 *
 * 為什麼獨立成檔（兩個理由，都跟這一層與語意層的分工有關）：
 *   1. **這是語意層的接縫**。本檔只做純字串比對，凡是需要看語意的都往上交給
 *      response-policy.ts 的 decideTurn（A.1 的「單純討論到蜜塔」、A.3 的連續追問）。
 *      判準換人時喚醒流程（debounce／派發）一行都不用動。
 *   2. **離線可評測**。`scripts/eval-meeting.ts` 直接 import 同一份判斷跑劇本，
 *      不必開真會議。線上跑的與評測的永遠是同一份（沿用 eval-interjection 的做法）。
 *
 * 本檔是**純函式**：不碰 session、不做 I/O、不看時鐘（now 由呼叫端傳入）。
 * 狀態變更由呼叫端依回傳的 decision 施加。
 */

// 字元集涵蓋 STT 常見誤轉：實測 recallai_streaming 會把「蜜塔」轉成「米塔」「蜜桃」等。
export const WAKE_WORD_REGEX = /[蜜密祕秘迷米咪][塔搭達桃]|小幫手|[Mm]e{1,2}ta|[Mm]ita/

/** 同一次喚醒的重複觸發抑制期。 */
export const DEBOUNCE_MS = 2000

/**
 * 「對話串還開著」的有效期：蜜塔最近一次被叫之後多久內，**沒喊名字**的發言仍值得
 * 送語意層問一句「這是不是在追問我」。
 *
 * 這不是舊 `WAKE_PENDING_MS` 待命窗的改名版，兩者的角色完全不同（2026-07-29 換掉）：
 *   舊待命窗是**判準**——窗內就直接當成問題，用時間去近似語意，於是只接得住
 *     「只叫名字 →（8 秒內）→ 問題」這一種句型，接不住第二、三輪追問（回報 A.3）。
 *   本常數只是**成本閘門**——判準交給語意層（它看得到前幾輪對話，本來就知道
 *     「那名額有限制嗎」在延續什麼）。這裡只負責擋掉「蜜塔根本沒參與過的對話」，
 *     免得整場會議每一句都送去問。
 * 因此可以放得比待命窗寬得多：判錯的成本由語意層承擔，不是由這個數字承擔。
 */
export const FOLLOWUP_WINDOW_MS = 90_000

/**
 * 明確的叫停指令。**定義在本檔而非 wake-word-detector**：兩個呼叫點要共用同一份詞表——
 *   ① barge-in（蜜塔正在說話時打斷，見 handleBargeIn）
 *   ② 定址判斷（本檔）：「蜜塔 不用了」曾被當成新問題送去查資料（回報 2026-07-28 唯一殘留的誤觸發）
 * 只有 ② 缺這個查表，症狀是叫停反而觸發一次檢索。
 *
 * `^...$` 錨定是刻意的：只認整句就是叫停的情形。
 * 「不用了，我們用另一個方案」是討論內容不是叫停，錨定讓它不會誤命中。
 * 措辭鬆散的叫停（「你先不用查了」）本層放過，留給語意決策層——
 * 這裡不追求覆蓋率，只求零延遲擋掉最常見、最刺眼的那幾句。
 */
export const STOP_COMMAND_REGEX = /^(閉嘴|安靜|住嘴|停|停止|別說了|不用了|不用說了|夠了)[。！!～~]*$/

/**
 * 剝除喚醒詞後殘留的開頭標點與空白。
 * 全形半形都要清：AGENT_MODE 走 OpenAI 轉錄，輸出的是**半形** `,` `.` `?`，
 * 舊的全形字元集清不掉 → 實測 2026-07-28 蜜塔覆誦出「,可以告訴我…」，
 * 而且這個逗號會一路帶進 Dify 的檢索查詢字串裡。
 */
export function stripLeadingPunct(text: string): string {
  return text.replace(/^[\s，。！？、…,.!?;:；：~～\-—]+/, '')
}

/**
 * 呼喚前綴：句首的發語詞／填充詞，出現在喚醒詞前面**不影響**它是呼喚。
 * 「那個蜜塔，幫我查一下」「欸蜜塔你可以查嗎」都是正常的叫人方式。
 */
const VOCATIVE_PREFIX_REGEX =
  /^(?:[\s，。！？、…,.!?~～-]|那個|欸|欵|唉|喂|嗯|好|所以|然後|請問|不好意思|抱歉|[Hh]ey|[Hh]i|[Oo][Kk])*/

/**
 * 喚醒詞是「句首呼喚」還是「句中提及」？
 *
 * 這是整個定址判斷的關鍵分界，也是成本分界：
 *   句首呼喚（蜜塔，X）→ 幾乎不可能誤判，純規則定案、零 LLM 成本、零延遲。
 *   句中提及（我覺得蜜塔X）→ 表面特徵分不出「對她說話」與「談論她」，
 *     必須看語意（回報 2026-07-28 A.1 的四個誤觸發全屬此類）。
 *
 * 實測反例（都是句中提及、都不該回應）：
 *   「我覺得蜜塔這個功能是不是有點難做啊」
 *   「對啊，我覺得蜜塔現在的判斷太死板了」
 *   「剛剛那個 Meeta 的回應真的很怪」
 *   「蜜塔剛才說截止日是六月三十號對吧」← 注意這句喚醒詞在句首，靠語意才分得出來
 */
function isVocativePosition(text: string, matchIndex: number): boolean {
  const prefix = VOCATIVE_PREFIX_REGEX.exec(text)?.[0] ?? ''
  return matchIndex <= prefix.length
}

/**
 * 呼喚語後面必然有停頓（「蜜塔，X」「蜜塔 X」），談論則直接黏下去（「蜜塔這個功能」）。
 * 這是分辨句首呼喚與句首提及的關鍵——兩者位置相同，只有這個分隔符不同：
 *   「蜜塔，請問這份規則…」→ 呼喚
 *   「蜜塔這個功能是不是有點難做」→ 談論（主題是蜜塔的功能）
 *   「蜜塔剛才說截止日是六月三十號對吧」→ 轉述（在向他人求證）
 * STT 實務上確實會在呼喚後插入逗號（回報 2026-07-28 那個「,可以告訴我」就是證據）。
 */
const POST_WAKE_SEPARATOR_REGEX = /^[\s，。！？、…,.!?;:；：~～]/

/**
 * partial 片段是否值得先 ack？**只看位置，不要求後面的分隔符**。
 *
 * 為什麼與定稿的判準不同：partial 是講到一半就推送的未定稿片段，
 * STT 的標點多半要到定稿才補上（「蜜塔請問」此刻還沒有那個逗號）。
 * 若比照定稿要求分隔符，agent 模式最重要的秒級 ack 會幾乎失效。
 *
 * 取捨：以「蜜塔」開頭的討論句（蜜塔這個功能…）仍會誤 ack 一句「我收到了」，
 * 但定稿階段會被語意裁決攔下、不會真的answer。
 * 相對地，句中提及（我覺得蜜塔…）在這裡就擋掉了——那才是回報 A.1 的大宗。
 */
export function isVocativeWake(text: string): boolean {
  const match = WAKE_WORD_REGEX.exec(text)
  return Boolean(match && isVocativePosition(text, match.index))
}

/** 定址判斷需要看的 session 狀態（MeetingSession 的子集，方便離線構造）。 */
export interface AddressingState {
  lastWakeAt: number
  /**
   * 蜜塔最近一次被叫到的時刻（epoch ms）：派發問題、只叫名字都算，叫停則歸零。
   * 0 = 目前沒有和蜜塔進行中的對話串。用途只有一個——決定沒喊名字的發言值不值得
   * 送語意層（見 {@link FOLLOWUP_WINDOW_MS}）。
   */
  lastEngagedAt: number
}

/** 現在還在「和蜜塔的對話串」裡嗎？線上與評測共用同一個判準。 */
export function isEngaged(state: Pick<AddressingState, 'lastEngagedAt'>, now: number): boolean {
  return state.lastEngagedAt > 0 && now - state.lastEngagedAt < FOLLOWUP_WINDOW_MS
}

export interface Utterance {
  text: string
  speaker: string
  /** epoch ms。純函式不讀時鐘，由呼叫端提供。 */
  now: number
}

export type AddressingDecision =
  /** 不是在跟蜜塔說話 → 什麼都不做。 */
  | { kind: 'ignore'; reason: string }
  /** 剛回應過，這句視為同一次喚醒的殘響 → 不重複回應。 */
  | { kind: 'debounced'; reason: string }
  /** 只叫了名字沒接問題 → 不回應，但對話串算是開了（後續發言值得送語意層）。 */
  | { kind: 'wake-only'; wakeWord: string; reason: string }
  /** 明確叫停（蜜塔 不用了／閉嘴）→ 閉嘴並關掉對話串，**不可**當成新問題。 */
  | { kind: 'stop'; reason: string }
  /**
   * 句中提及了蜜塔，但分不出是「對她說話」還是「談論她」→ 交給語意層裁決。
   * candidate 是「若真的是提問，問題會是什麼」，語意層判定為提問時直接拿去用。
   */
  | { kind: 'ambiguous'; wakeWord: string; candidate: string; reason: string }
  /**
   * 沒喊名字，但蜜塔近期被叫過 → 可能是連續追問（回報 A.3），交給語意層看整段對話裁決。
   * 與 ambiguous 的差別只在**呼叫失敗時的退回方向**（見 AddressVerdict 的說明）。
   */
  | { kind: 'followup-candidate'; candidate: string; reason: string }
  /** 確定在問蜜塔，且問題內容已擷取出來 → 派發。 */
  | { kind: 'question'; question: string; reason: string }

/**
 * 語音段落的定址判斷（規則層）。
 *
 * 本層只做「零成本就能定案」與「值不值得花一次語意判斷」兩件事，其餘一律往上交：
 *   句首呼喚「蜜塔，X」        → 直接定案（question），零延遲
 *   叫停「蜜塔 不用了」        → 直接定案（stop），不花 LLM
 *   句中提及「我覺得蜜塔X」    → ambiguous，語意層判對她說 vs 談論她
 *   沒喊名字但對話串還開著     → followup-candidate，語意層判是不是追問
 *   沒喊名字、對話串也沒開     → ignore，連問都不問（誤觸發與成本的主要防線）
 */
export function decideAddressing(state: AddressingState, u: Utterance): AddressingDecision {
  const match = WAKE_WORD_REGEX.exec(u.text)

  if (!match) {
    // 沒喊名字：只有在「和蜜塔的對話串還開著」時才值得問語意層。
    // 這一關擋掉整場會議絕大多數的一般討論——不擋的話，每一句話都要花一次呼叫。
    if (!isEngaged(state, u.now)) return { kind: 'ignore', reason: 'no wake word (no open thread)' }

    const candidate = stripLeadingPunct(u.text).trim()
    if (!candidate) return { kind: 'ignore', reason: 'open thread but empty text' }
    // 對話串裡回一句「不用了」是收回上一個呼喚，不是要問「不用了」
    if (STOP_COMMAND_REGEX.test(candidate)) {
      return { kind: 'stop', reason: 'stop command in open thread' }
    }
    if (u.now - state.lastWakeAt < DEBOUNCE_MS) {
      return { kind: 'debounced', reason: 'within debounce window' }
    }
    return { kind: 'followup-candidate', candidate, reason: 'open thread (possible follow-up)' }
  }

  const after = u.text.slice(match.index + match[0].length)
  const question = stripLeadingPunct(after).trim()

  // 叫停先於 debounce 判定：「蜜塔閉嘴」多半緊接在她開口後 2 秒內，
  // 若讓 debounce 先攔下，這句就整個被丟掉、該有的閉嘴動作也不會發生。
  // 也先於 ambiguous：叫停不必花一次 LLM 去問「這是不是在跟我說話」。
  if (STOP_COMMAND_REGEX.test(question)) {
    return { kind: 'stop', reason: `stop command「${question}」` }
  }

  if (u.now - state.lastWakeAt < DEBOUNCE_MS) {
    return { kind: 'debounced', reason: 'within debounce window' }
  }

  // 只叫名字沒接問題：不回應，但把對話串打開，**不消耗 debounce**
  //（STT 常把「蜜塔，」finalize 成獨立 utterance，問題在下一段——
  //  那一段就會是 followup-candidate，由語意層接上）。
  // 這個判斷不需要語意——後面根本沒有內容可以談論。
  if (!question) {
    return { kind: 'wake-only', wakeWord: match[0], reason: 'wake word without question' }
  }

  // 不是呼喚句型 → 不自行定案，交給語意裁決（純規則在這裡必錯，見上方反例）
  if (!isVocativePosition(u.text, match.index) || !POST_WAKE_SEPARATOR_REGEX.test(after)) {
    return {
      kind: 'ambiguous',
      wakeWord: match[0],
      candidate: question,
      reason: 'wake word not in vocative form (mention vs address unclear)',
    }
  }

  return { kind: 'question', question, reason: `vocative「${match[0]}」` }
}

/**
 * 聊天室訊息的定址判斷。
 * 比語音簡單：沒有 STT 斷句問題，打字時人一定會把問題打完，所以沒喊名字就是沒在叫她
 *（聊天室的連續追問由插話決策層在 turn 結束時一併處理，與語音同一份 decideTurn）。
 */
export function decideChatAddressing(
  state: Pick<AddressingState, 'lastWakeAt'>,
  u: Utterance,
): AddressingDecision {
  const match = WAKE_WORD_REGEX.exec(u.text)
  if (!match) return { kind: 'ignore', reason: 'no wake word' }
  if (u.now - state.lastWakeAt < DEBOUNCE_MS) {
    return { kind: 'debounced', reason: 'within debounce window' }
  }
  const after = u.text.slice(match.index + match[0].length)
  const question = stripLeadingPunct(after).trim()
  // debounce 在確認有問題內容後才消耗，避免空喚醒吃掉緊接著的真問題。
  if (!question) return { kind: 'ignore', reason: 'wake word without question (chat)' }
  // 聊天室打「蜜塔 不用了」同樣是叫停（語音路徑同一套詞表）
  if (STOP_COMMAND_REGEX.test(question)) return { kind: 'stop', reason: `stop command「${question}」` }
  // 聊天室同樣有「打字討論蜜塔」的情形，判斷準則與語音一致
  if (!isVocativePosition(u.text, match.index) || !POST_WAKE_SEPARATOR_REGEX.test(after)) {
    return {
      kind: 'ambiguous',
      wakeWord: match[0],
      candidate: question,
      reason: 'wake word mid-message (mention vs address unclear)',
    }
  }
  return { kind: 'question', question, reason: `vocative「${match[0]}」` }
}
