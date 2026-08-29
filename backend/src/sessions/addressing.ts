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
// 「茶」「麗」是 2026-08-04 實機補的——那場整句「蜜茶我想知道你冷場插話的時機」
// 因為漏字完全沒被喚醒。誤轉集中在**她正在說話的時候**（AEC 雙講失真），
// 而那正是使用者最需要叫得動她的時刻，所以字元集寧可寬：
// 多收進來的句子還要過句首呼喚／分隔符判斷，最壞只是多花一次語意裁決。
// 字元集是實測 STT 誤轉一個一個加上來的（米塔／蜜桃／畢達／碧塔／嘿塔／密卡…）。
// 「卡」與「畢碧嘿」「Vita」是 2026-08-29 從全 log 掃描補的：光「米卡／密卡」就漏掉
// 13 句真的在叫她的話。
// **刻意不收「立」「嗯」**——「立場」「立大」是常用詞，收了會在正常討論時誤觸發
// （實測 08-17 的「立陶閉嘴」只能交給 barge-in 的字尾推定接，不進喚醒詞表）。
export const WAKE_WORD_REGEX =
  /[蜜密祕秘迷米咪麗畢碧嘿][塔搭達桃茶卡]|小幫手|[Mm]e{1,2}ta|[Mm]ita|[Vv]ita/

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
 *
 * 安靜的字元集同喚醒詞（黑：實測 2026-08-17「蜜塔安靜」在她說話時被轉成「蜜塔安黑」——
 * 雙講期間的失真比安靜期更兇）：實測 2026-08-04「蜜塔安靜」被轉成「蜜塔安傑」，
 * 於是她停是停了（barge-in 只看長度），卻沒被當成叫停——被打斷的答案照樣轉貼聊天室，
 * 對話串也照樣開著，下一句就被當成新問題。叫停失敗最刺眼的就是這種「停不乾淨」。
 */
export const STOP_COMMAND_REGEX =
  /^(閉嘴|安[靜傑進靖黑](?:點|一點)?|住嘴|住口|噤聲|停|停止|停一下|先停|暫停|別說了|別講了|不要說了|不要講了|不用了|不用[說講查念]了?|不用查|夠了|夠囉|好了啦|[Ss]hut\s*up|[Ss]top|[Qq]uiet|[Ss]ilence)[。！!？?～~，,.]*$/

/**
 * 叫停後面還接著講的形態（「蜜桃閉嘴他是念 Gemini 耶」——實測 2026-08-03 漏掉）。
 *
 * 詞表刻意比 {@link STOP_COMMAND_REGEX} **窄**，差別在能不能單獨成立為命令：
 *   收：閉嘴／安靜／住嘴／別說了／夠了 —— 句首出現就是在叫人閉嘴，沒有第二種讀法
 *   不收：停／停止／不用了 —— 討論裡太常見（「不用了，我們改用另一個方案」是內容），
 *        這幾個只有整句都是它時才算數
 */
const STOP_COMMAND_PREFIX_REGEX = /^(閉嘴|安[靜傑進靖黑]|住嘴|住口|噤聲|別說了|別講了|夠了)/

/**
 * 禮貌／迂迴的叫停（實測全 log 挖出來的 B 類漏網）：
 *   「蜜塔，你可以閉嘴嗎?」（08-17 20:52）／「你可以安靜囉。」（08-16 23:57）
 *   「蜜塔請安靜」（08-16 23:59）／「你閉嘴就好了」（07-29 22:56）
 *   「蜜塔可以先不用來補充一下」（08-26 10:24）
 * 這些全部不在原詞表裡——原本要求叫停詞出現在最前面，被「你」「請」「可以」擋掉。
 *
 * 主語限定 你／妳／您（或省略）是**唯一**的分界線，不能放寬成任意主語：
 *   「蜜塔，我可以叫你閉嘴嗎?」（08-14 15:50）是在問她功能，不是在叫她閉嘴。
 */
const STOP_POLITE_REGEX =
  /^(?:你|妳|您)?\s*(?:先|可以|能不能|能|麻煩|拜託|請|給我)*\s*(?:不要再?|別再?|不用再?|停止)?\s*(?:安靜|閉嘴|住嘴|住口|噤聲|(?:不要|別|不用)(?:再)?[^，。,.]{0,4}?(?:說|講|念|回答|查|補充|回))/

/**
 * 「停」單獨太常見（停車場在哪裡／這個功能停在哪一版），所以必須掛情態詞才算命令。
 * 救的是「蜜塔你可以先停一下」「你先不要講了好嗎」這類——旁人講出來時，
 * adaptive 的字數門檻一次都停不了（見 wake-word-detector.ts 的 BARGE_IN_MIN_CHARS_BYSTANDER）。
 */
const STOP_PAUSE_REGEX =
  /^(?:你|妳|您)?\s*(?:先|可以先|可以|能不能|能|麻煩|拜託|請)+\s*(?:不要再?|別再?|不用再?)?\s*停(?:一下|下來)?/

/**
 * 叫停詞後面還能接多少字。
 *
 * 20 而不是不限：per-track 是主要路徑、逐句到達，用不到更寬；webhook fallback
 * 的整輪拼接 blob 才需要 40，但那條路的覆蓋率不值得換誤判風險。
 */
const STOP_TAIL_MAX = 20

/**
 * 叫停詞後面緊接「的／之」＝ 名詞化／條件化，**那是在談論這個動作，不是在下命令**。
 *
 * 這條句法特徵才是誤判的真正分界，長度不是：
 *   「閉嘴**他是**念Gemini耶」   → 命令（既有測試要求為 true）
 *   「閉嘴**的話**,他可能就是…」 → 討論（08-26 10:23:23，全 log 單一時刻最大的誤判爆量，
 *                                  同一秒 82 筆 partial 全部被當成叫停）
 */
const STOP_NOMINALIZED_REGEX = /^[的之]/

/** 剝掉開頭的喚醒詞（沒有就原樣回傳），讓叫停判斷不必在意有沒有喊名字。 */
function stripWakeWord(text: string): string {
  const m = WAKE_WORD_REGEX.exec(text)
  return m ? text.slice(m.index + m[0].length) : text
}

/**
 * 問題文字的正規化（剝喚醒詞＋前置標點）——**「同一題」的比對基準**。
 *
 * 呼喚路徑派發前會剝掉「蜜塔,」，語意層從對話窗挑的是原文；同一句話兩個字串
 * 差一個前綴，跳針防護用原字串比對就攔不住（實測 2026-08-17 深夜：
 * 同一題「我想知道使用者分析…」收到兩次、答了兩次）。
 * 任何要判斷「這題是不是剛答過」的地方，兩邊都先過這個函式。
 */
export function normalizeQuestionText(text: string): string {
  return stripLeadingPunct(stripWakeWord(text)).trim()
}

/**
 * 這句話是不是在叫停？**兩個呼叫點的唯一真相**——barge-in（handleBargeIn）與
 * 定址判斷（本檔）共用它，兩處對「什麼算叫停」的認定分岔的話，
 * 會出現「打斷得了、卻同時被當成新問題送去查資料」這種自相矛盾的行為。
 */
export function isStopCommand(text: string): boolean {
  // 只有喚醒詞落在**呼喚位置**（句首，或前面只有「那個」「欸」這類贅詞）時才剝。
  //
  // stripWakeWord 用的是無錨定比對，會把喚醒詞之前的整段都吃掉，於是任何句子只要
  // 中間出現「蜜塔閉嘴」，剝完就變成 ^閉嘴… → 判成叫停。實測 2026-08-26：
  //   「…就是像我們叫蜜塔閉嘴或者…」    → 她該回答時裝死
  //   「你們剛剛講到那個 就是說教蜜塔閉嘴的那個東西…」→ 同上
  // 這是多人會議專屬的踩雷——只有多人才會坐在會議裡討論這個功能本身。
  const m = WAKE_WORD_REGEX.exec(text)
  const body = m && isVocativePosition(text, m.index) ? text.slice(m.index + m[0].length) : text
  const rest = stripLeadingPunct(body).trim()
  if (STOP_COMMAND_REGEX.test(rest)) return true

  // 三個句首分支共用同一組尾巴檢查：接「的／之」＝在討論，太長＝不是在下命令。
  for (const re of [STOP_COMMAND_PREFIX_REGEX, STOP_POLITE_REGEX, STOP_PAUSE_REGEX]) {
    const hit = re.exec(rest)
    if (!hit) continue
    const tail = rest.slice(hit[0].length)
    if (STOP_NOMINALIZED_REGEX.test(tail)) continue
    if (tail.length <= STOP_TAIL_MAX) return true
  }
  return false
}

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
    if (isStopCommand(u.text)) {
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
  if (isStopCommand(u.text)) {
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
  if (isStopCommand(u.text)) return { kind: 'stop', reason: `stop command「${question}」` }
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
