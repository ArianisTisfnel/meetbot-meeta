import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ── mocks ─────────────────────────────────────────────────────────────────────
// env 用可變物件：各 describe 切換 INTERJECTION_ENABLED / ICEBREAKER_ENABLED 等開關
const mockEnv = vi.hoisted(() => ({
  INTERJECTION_ENABLED: true,
  INTERJECTION_TURN_DETECTOR: 'silence' as 'silence' | 'livekit',
  INTERJECTION_TURN_SILENCE_MS: 2_500,
  INTERJECTION_EOU_CHECK_MS: 1_000,
  INTERJECTION_EOU_LANGUAGE: 'zh',
  INTERJECTION_EOU_THRESHOLD: 0.1,
  INTERJECTION_COOLDOWN_MS: 90_000,
  ICEBREAKER_ENABLED: true,
  ICEBREAKER_SILENCE_MS: 40_000,
  ICEBREAKER_COOLDOWN_MS: 300_000,
}))
vi.mock('../../../../backend/src/types/env', () => ({ env: mockEnv }))

// interjection 的執行層走 wake-word-detector 的三個函式 → 全部 mock 掉觀察呼叫
const wwd = vi.hoisted(() => ({
  resolveAnswer: vi.fn(),
  sendChatBestEffort: vi.fn().mockResolvedValue(undefined),
  speakProactive: vi.fn().mockResolvedValue(true),
  answerFollowUp: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../backend/src/sessions/wake-word-detector', () => wwd)

const eou = vi.hoisted(() => ({
  warmEouModel: vi.fn(),
  isEndOfTurn: vi.fn(),
}))
vi.mock('../../../../backend/src/lib/eou', () => eou)

// interjection.ts 匯入哨兵句常數 → 提供同值 mock（真值定義在 lib/dify.ts）
vi.mock('../../../../backend/src/lib/dify', () => ({
  DIFY_NO_RESULT_SENTINEL: '抱歉 沒有檢索到相關資訊',
}))

const llm = vi.hoisted(() => ({ completeText: vi.fn() }))
vi.mock('../../../../backend/src/lib/llm', () => llm)

import { activeSessions } from '../../../../backend/src/sessions/session-store'
import { recordSpeechOn, recordSpeechOff, clearSpeakerTimeline } from '../../../../backend/src/agent/speaker-timeline'
import {
  recordConversation,
  startIcebreaker,
  noteHumanSpeaking,
  clearInterjection,
} from '../../../../backend/src/sessions/interjection'
import {
  ICEBREAKER_OPENING_WITH_KB,
  ICEBREAKER_OPENING_NO_KB,
  ICEBREAKER_SUMMARY_SYSTEM,
  TURN_DECISION_SYSTEM,
} from '../../../../backend/src/sessions/interjection-prompts'
import type { MeetingSession } from '../../../../backend/src/types/session'
import type { BotSession } from '../../../../backend/src/provider/types'

const MEETING_ID = 'meet-ij-1'

function fakeBotSession(): BotSession {
  return {
    provider: 'recall',
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    providerMeetingId: 42,
    adapter: {} as any,
    state: {},
  }
}

function putSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  const session: MeetingSession = {
    meetingInstanceId: MEETING_ID,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    isSpeaking: false,
    lastWakeAt: 0,
    lastEngagedAt: 0,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    speechEndsAt: 0,
    chatLog: [],
    sessionStartedAt: 0,
    bargeEpoch: 0,
    lastStopAt: 0,
    speechGen: 0,
    processedSegmentIds: new Set(),
    botSession: fakeBotSession(),
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
    ...overrides,
  }
  activeSessions.set(session.meetingInstanceId, session)
  return session
}

function humanEntry(text: string, speaker = '小明', source: 'voice' | 'chat' = 'voice') {
  return { speaker, text, source, fromBot: false, at: Date.now() }
}

/**
 * 每輪決策層的 JSON 輸出（2026-07-29 起定址／意圖／插話同一次呼叫產出）。
 * addressed 預設 none：測插話的劇本都是「沒人叫蜜塔」的情境。
 */
function decision(o: Partial<{ addressed: string; question: string; intent: string; interject: boolean }> = {}) {
  return JSON.stringify({
    addressed: o.addressed ?? 'none',
    question: o.question ?? '',
    intent: o.intent ?? 'factual',
    interject: o.interject ?? false,
  })
}
const quiet = () => decision()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  // 預設值還原（各 describe 的 beforeEach 再覆蓋）
  mockEnv.INTERJECTION_ENABLED = true
  mockEnv.INTERJECTION_TURN_DETECTOR = 'silence'
  mockEnv.ICEBREAKER_ENABLED = true
  llm.completeText.mockResolvedValue(quiet())
  wwd.resolveAnswer.mockResolvedValue('預設答案')
  eou.isEndOfTurn.mockResolvedValue(null)
})

afterEach(() => {
  clearInterjection(MEETING_ID)
  activeSessions.clear()
  vi.useRealTimers()
})

// ── 沉默破冰 icebreaker ───────────────────────────────────────────────────────

describe('icebreaker — 沉默破冰', () => {
  beforeEach(() => {
    mockEnv.INTERJECTION_ENABLED = false // 隔離：只測破冰
    mockEnv.ICEBREAKER_ENABLED = true
  })

  it('開場沉默 40s（有知識庫）→ 說出罐頭引導（KB 版文案）', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(39_999)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, ICEBREAKER_OPENING_WITH_KB, 'icebreaker')
    expect(llm.completeText).not.toHaveBeenCalled() // 罐頭台詞不走 LLM
  })

  it('開場沉默（無知識庫）→ 用無 KB 版文案', async () => {
    const session = putSession({ difyDatasetId: null })
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, ICEBREAKER_OPENING_NO_KB, 'icebreaker')
  })

  it('任何發言都重置沉默計時（39s 時有人講話 → 從那刻重新起算 40s）', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(39_000)
    recordConversation(session, humanEntry('我先看一下資料'))
    await vi.advanceTimersByTimeAsync(39_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('會議中沉默（人類發言 ≥2）→ 用 LLM 總結+拋問題（ICEBREAKER_SUMMARY_SYSTEM）', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('我們先討論預算'))
    recordConversation(session, humanEntry('A 方案要 50 萬', '小華'))
    llm.completeText.mockResolvedValueOnce('目前聊到 A 方案預算 50 萬。大家覺得要先確認資金來源嗎？')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(llm.completeText).toHaveBeenCalledTimes(1)
    const call = llm.completeText.mock.calls[0][0]
    expect(call.system).toBe(ICEBREAKER_SUMMARY_SYSTEM)
    expect(call.prompt).toContain('[小明] 我們先討論預算')
    expect(call.prompt).toContain('[小華] A 方案要 50 萬')
    expect(wwd.speakProactive).toHaveBeenCalledWith(
      session,
      '目前聊到 A 方案預算 50 萬。大家覺得要先確認資金來源嗎？',
      'icebreaker',
    )
  })

  it('破冰後進入 5 分鐘冷卻：期間到點都跳過，冷卻結束＋有人再發言後才會再破冰', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000) // 第一次破冰（t=40s）
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(240_000) // t=280s：冷卻中，全部跳過
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    recordConversation(session, humanEntry('我們繼續吧')) // t=280s 有人開口
    await vi.advanceTimersByTimeAsync(40_000) // t=320s 到點：距上次 280s，仍在冷卻 → 跳過
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(40_000) // t=360s 到點：冷卻過＋有新發言 → 觸發
    expect(wwd.speakProactive).toHaveBeenCalledTimes(2)
  })

  it('破冰後無人再發言 → 永不重複破冰；有人開口後的新沉默才會再觸發', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('先討論預算'))
    recordConversation(session, humanEntry('好啊', '小華'))
    llm.completeText.mockResolvedValueOnce('聊到預算了。要先確認什麼？')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    // 冷卻結束很久之後也一樣：沒有人類新發言 → 不重複（修正前會連發相同總結）
    await vi.advanceTimersByTimeAsync(400_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    recordConversation(session, humanEntry('欸大家還在嗎', '阿傑'))
    llm.completeText.mockResolvedValueOnce('剛才停在預算。要繼續嗎？')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(2)
  })

  // ── 2026-08-03 19:20 實機事故：同一句罐頭破冰講了兩次，第二次還蓋在使用者身上 ──

  it('第二次破冰不重播罐頭句（改走總結路線）', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, ICEBREAKER_OPENING_WITH_KB, 'icebreaker')

    // 冷卻過後有人問了一題：人類發言只有 1 則，修正前 humanEntries<2 會再唸一次
    // 一模一樣的「大家好像還沒開始討論」——但討論明明已經開始了。
    await vi.advanceTimersByTimeAsync(300_000)
    recordConversation(session, humanEntry('蜜塔，我們有什麼競品嗎'))
    llm.completeText.mockResolvedValueOnce('剛聊到競品比較，要不要挑一個深入看？')
    await vi.advanceTimersByTimeAsync(40_000)

    expect(wwd.speakProactive).toHaveBeenCalledTimes(2)
    expect(wwd.speakProactive.mock.calls[1][1]).toBe('剛聊到競品比較，要不要挑一個深入看？')
    expect(llm.completeText.mock.calls[0][0].system).toBe(ICEBREAKER_SUMMARY_SYSTEM)
  })

  // 實機 2026-08-03 20:13:21 通過檢查、20:13:22 就講出去了——中間那 1-2 秒的 LLM 生成
  // 沒有任何東西能喊停，使用者在那一秒開口完全來不及擋。
  it('準備期間有人開口（只有 partial、定稿還沒到）→ 放棄本輪', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('先討論預算'))
    recordConversation(session, humanEntry('好啊', '小華'))

    let finishLlm!: (text: string) => void
    llm.completeText.mockReturnValueOnce(new Promise<string>((r) => { finishLlm = r }))
    await vi.advanceTimersByTimeAsync(40_000) // 到點 → 卡在 LLM 生成

    noteHumanSpeaking(MEETING_ID) // 她開口了，只有 partial
    finishLlm('剛聊到預算，要繼續嗎？')
    await vi.advanceTimersByTimeAsync(1)

    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('partial 逐字稿（還沒定稿）也算有人在講話 → 重置沉默計時', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(39_000)
    noteHumanSpeaking(MEETING_ID) // 她開口了，定稿還要 1.5–3 秒才到
    await vi.advanceTimersByTimeAsync(39_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('到點時蜜塔正在說話 → 本輪跳過、繼續監看下一段沉默', async () => {
    const session = putSession({ isSpeaking: true })
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    session.isSpeaking = false
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('剛有喚醒問答（lastWakeAt 距今 < 40s）→ 不是真沉默，跳過', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(30_000)
    session.lastWakeAt = Date.now() // 模擬 30s 時發生喚醒問答
    await vi.advanceTimersByTimeAsync(10_000) // 40s 到點：距喚醒僅 10s → 跳過
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(40_000) // 下一輪：距喚醒 50s → 觸發
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('LLM 失敗 → 本輪安靜跳過、繼續監看（不 throw、不出聲）', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('討論一下時程'))
    recordConversation(session, humanEntry('好啊', '小華'))
    llm.completeText.mockRejectedValueOnce(new Error('rate limited'))
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    llm.completeText.mockResolvedValueOnce('剛才聊到時程。要不要先訂里程碑？')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('喚醒查詢寬限：距上次喚醒 <45s 不破冰（Dify 鏈最長 45s，避免與遲到的答案自打臉）', async () => {
    const session = putSession()
    startIcebreaker(session)
    session.lastWakeAt = Date.now() // 剛有人喚醒提問（查詢可能還在跑）
    await vi.advanceTimersByTimeAsync(40_000) // 到點：距喚醒 40s < 45s 寬限 → 跳過
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(40_000) // 下一輪：距喚醒 80s → 觸發
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('LLM 回空字串 → 本輪不出聲，且監看不中斷（下一輪照常破冰）', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('討論一下分工'))
    recordConversation(session, humanEntry('我可以做前端', '小華'))
    llm.completeText.mockResolvedValueOnce('   ')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    llm.completeText.mockResolvedValueOnce('剛才聊到分工。後端誰要接？')
    await vi.advanceTimersByTimeAsync(40_000) // 修正前：計時器已斷線，這裡永遠不觸發
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('LLM 生成期間有人開口 → 放棄本輪破冰（不撞車）、監看繼續', async () => {
    const session = putSession()
    startIcebreaker(session)
    recordConversation(session, humanEntry('我們來討論預算'))
    recordConversation(session, humanEntry('抓 50 萬吧', '小華'))
    llm.completeText.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 50) // 生成期間有人提問
      recordConversation(session, humanEntry('欸等等我有問題', '阿傑'))
      return '目前聊到預算 50 萬。要先確認資金來源嗎？'
    })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled() // 撞車防護生效
    // 監看沒斷：之後真的冷場 → 下一輪照常破冰
    llm.completeText.mockResolvedValueOnce('剛才聊到預算。下一步要確認什麼？')
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('ICEBREAKER_ENABLED=false → startIcebreaker 完全不排程', async () => {
    mockEnv.ICEBREAKER_ENABLED = false
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })
})

// ── 主動插話 interjection（silence 時機層）────────────────────────────────────

describe('interjection — 主動插話（silence 時機層）', () => {
  beforeEach(() => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false // 隔離：只測插話
  })

  it('人類發言後靜默 2.5s → 呼叫決策器（帶正確 system 與對話窗、聊天室標記）', async () => {
    const session = putSession()
    recordConversation(session, humanEntry('報名截止日是什麼時候？'))
    recordConversation(session, humanEntry('我在聊天室補充一下', '小華', 'chat'))
    await vi.advanceTimersByTimeAsync(2_499)
    expect(llm.completeText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(llm.completeText).toHaveBeenCalledTimes(1)
    const call = llm.completeText.mock.calls[0][0]
    expect(call.system).toBe(TURN_DECISION_SYSTEM)
    expect(call.prompt).toContain('[小明] 報名截止日是什麼時候？')
    expect(call.prompt).toContain('[小華·聊天室] 我在聊天室補充一下')
  })

  it('決策 = 不插話 → 不投遞任何訊息', async () => {
    const session = putSession()
    recordConversation(session, humanEntry('我覺得 A 方案比較好'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(1)
    expect(wwd.resolveAnswer).not.toHaveBeenCalled()
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('決策 = 插話且全場仍沉默 → 語音說「我補充一下：…」', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce(decision({ interject: true, question: '報名截止日是什麼時候' }))
    wwd.resolveAnswer.mockResolvedValueOnce('報名截止日是 6 月 30 日。')
    recordConversation(session, humanEntry('報名截止日是什麼時候？有人知道嗎'))
    await vi.advanceTimersByTimeAsync(2_500)
    // intent 一併從同一次決策帶下去 → resolveAnswer 不必再打一次分類
    expect(wwd.resolveAnswer).toHaveBeenCalledWith(session, '報名截止日是什麼時候', 'chat', 'factual')
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, '我補充一下：報名截止日是 6 月 30 日。', 'interjection')
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
  })

  it('決策 = 插話但查詢期間有人開口 → 改貼聊天室 💡（不搶話）', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce(decision({ interject: true, question: '隊伍人數上限是多少' }))
    wwd.resolveAnswer.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 50) // 查詢期間時間前進，讓新發言的 at 可區分
      recordConversation(session, humanEntry('欸我想到另一件事', '小華'))
      return '每隊最多 5 人。'
    })
    recordConversation(session, humanEntry('隊伍人數上限是多少？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.sendChatBestEffort).toHaveBeenCalledWith(session, '💡 每隊最多 5 人。', 'chat', 'interjection')
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('決策 = 插話但檢索沒中（哨兵句）→ 放棄投遞，冷卻照計', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce(decision({ interject: true, question: '報名費多少' }))
    wwd.resolveAnswer.mockResolvedValueOnce('抱歉 沒有檢索到相關資訊')
    recordConversation(session, humanEntry('報名費多少啊？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.resolveAnswer).toHaveBeenCalledTimes(1)
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    // 冷卻照計：同題再觸發，決策器不再被呼叫（避免連環浪費 quota）
    recordConversation(session, humanEntry('所以報名費到底是多少？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(1)
  })

  it('決策 = 插話但答案是空字串 → 放棄投遞', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce(decision({ interject: true, question: '地點在哪' }))
    wwd.resolveAnswer.mockResolvedValueOnce('')
    recordConversation(session, humanEntry('比賽地點在哪？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('插話後 90s 冷卻：期間新的發言到點不再呼叫決策器', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce(decision({ interject: true, question: '截止日' }))
    wwd.resolveAnswer.mockResolvedValueOnce('6/30。')
    recordConversation(session, humanEntry('截止日？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(1)

    recordConversation(session, humanEntry('那地點在哪裡？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(1) // 冷卻中，沒有第二次決策

    await vi.advanceTimersByTimeAsync(90_000) // 冷卻過後
    recordConversation(session, humanEntry('所以地點到底在哪？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(2)
  })

  it('喚醒寬限內、且對話串沒開著 → 不評估（省一次呼叫）', async () => {
    const session = putSession()
    session.lastWakeAt = Date.now()
    recordConversation(session, humanEntry('剛剛那個答案的出處是？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).not.toHaveBeenCalled()
  })

  it('蜜塔自己的訊息會取消進行中的評估計時、也不開新計時', async () => {
    const session = putSession()
    recordConversation(session, humanEntry('截止日是什麼時候？'))
    await vi.advanceTimersByTimeAsync(1_000)
    recordConversation(session, { speaker: '蜜塔', text: '截止日是 6/30。', source: 'chat', fromBot: true, at: Date.now() })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(llm.completeText).not.toHaveBeenCalled()
  })

  it('決策器回傳非 JSON → 安全跳過（不 throw、不投遞）', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce('嗯，我認為現在不需要插話。')
    recordConversation(session, humanEntry('報名費是多少？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.resolveAnswer).not.toHaveBeenCalled()
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
  })
})

// ── 沒喊名字的連續追問（回報 A.3）──────────────────────────────────────────────
//
// 與插話是**同一次 LLM 呼叫**的兩個出口：addressed=address 走這裡（當成喚醒問答回答），
// 否則才看 interject。這是 A.3 從「只能靠 8 秒待命窗」變成「看得懂整段對話」的關鍵。

describe('interjection — 連續追問（addressed=address）', () => {
  beforeEach(() => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false
  })

  /** 剛問過蜜塔：對話串開著，且落在喚醒寬限內（A.3 的真實時序）。 */
  function engagedSession() {
    return putSession({ lastEngagedAt: Date.now(), lastWakeAt: Date.now() })
  }

  it('對話串開著時，喚醒寬限**不再**擋掉評估（否則追問永遠接不上）', async () => {
    const session = engagedSession()
    recordConversation(session, humanEntry('那名額有限制嗎', 'Arianis'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).toHaveBeenCalledTimes(1)
  })

  it('判定 address → 走喚醒問答的路（不是插話）', async () => {
    const session = engagedSession()
    llm.completeText.mockResolvedValueOnce(
      decision({ addressed: 'address', question: '那名額有限制嗎', intent: 'factual' }),
    )
    recordConversation(session, humanEntry('那名額有限制嗎', 'Arianis'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).toHaveBeenCalledWith(session, '那名額有限制嗎', 'voice', {
      speaker: 'Arianis',
      intent: 'factual',
    })
    // 插話的投遞路徑完全沒被走到
    expect(wwd.speakProactive).not.toHaveBeenCalled()
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
  })

  // 實機 2026-08-03 19:35：聊天室打的那題答案還在查，她又出了一次聲，語意層把**同一句
  // 原文**從對話窗撈出來當成新追問 → 聊天室答一次、語音又答一次。
  it('剛派發過的同一題 → 不再答第二次', async () => {
    const session = engagedSession()
    session.lastDispatchedQuestion = { text: '我們這個月有甚麼目標嗎', at: Date.now() }
    llm.completeText.mockResolvedValueOnce(
      decision({ addressed: 'address', question: '我們這個月有甚麼目標嗎' }),
    )
    recordConversation(session, humanEntry('嗯', 'WENDY'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
  })

  // 實機 2026-08-17 深夜：呼喚路徑派發的是剝掉「蜜塔,」的版本、語意層從對話窗撈的是
  // 帶喚醒詞的原文，只差一個前綴就繞過跳針防護 → 同一題兩個 ack、答兩次。
  it('同一題只差喚醒詞前綴（「蜜塔,X」vs「X」）→ 仍視為同一題，不答第二次', async () => {
    const session = engagedSession()
    session.lastDispatchedQuestion = { text: '我想知道我們的使用者分析以及產品的競品分析。', at: Date.now() }
    llm.completeText.mockResolvedValueOnce(
      decision({ addressed: 'address', question: '蜜塔,我想知道我們的使用者分析以及產品的競品分析。' }),
    )
    recordConversation(session, humanEntry('嗯', 'WENDY'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
  })

  it('同一題但已經過了一分鐘 → 當成沒聽到，照答', async () => {
    const session = engagedSession()
    session.lastDispatchedQuestion = { text: '我們這個月有甚麼目標嗎', at: Date.now() - 61_000 }
    llm.completeText.mockResolvedValueOnce(
      decision({ addressed: 'address', question: '我們這個月有甚麼目標嗎' }),
    )
    recordConversation(session, humanEntry('我們這個月有甚麼目標嗎', 'WENDY'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).toHaveBeenCalledTimes(1)
  })

  it('聊天室打的追問 → 從聊天室回', async () => {
    const session = engagedSession()
    llm.completeText.mockResolvedValueOnce(decision({ addressed: 'address', question: '那報名費呢' }))
    recordConversation(session, humanEntry('那報名費呢', '小華', 'chat'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).toHaveBeenCalledWith(session, '那報名費呢', 'chat', expect.anything())
  })

  it('對話串已關（叫停／逾時）→ 就算判 address 也不接話', async () => {
    const session = putSession({ lastEngagedAt: 0 })
    llm.completeText.mockResolvedValueOnce(decision({ addressed: 'address', question: '那名額有限制嗎' }))
    recordConversation(session, humanEntry('那名額有限制嗎'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
  })

  it('判 address 但沒擷出問題 → 不接話（不可自行發明問題）', async () => {
    const session = engagedSession()
    llm.completeText.mockResolvedValueOnce(decision({ addressed: 'address', question: '' }))
    recordConversation(session, humanEntry('嗯嗯了解'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
  })

  it('呼叫失敗（JSON 壞掉）→ **退回安靜**，與句中提及的方向相反', async () => {
    // 這裡沒人喊名字：退回「照常回答」等於額度枯竭時把每一句話都當成在問她。
    const session = engagedSession()
    llm.completeText.mockResolvedValueOnce('429 之類的鬼東西')
    recordConversation(session, humanEntry('那我們先討論別的'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('判 none → 落回插話判斷；仍在喚醒寬限內就閉嘴', async () => {
    const session = engagedSession()
    llm.completeText.mockResolvedValueOnce(decision({ addressed: 'none', question: '地點在哪', interject: true }))
    recordConversation(session, humanEntry('欸對了地點在哪'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.answerFollowUp).not.toHaveBeenCalled()
    expect(wwd.resolveAnswer).not.toHaveBeenCalled()
  })

  it('INTERJECTION_ENABLED=false → 發言不排評估計時', async () => {
    mockEnv.INTERJECTION_ENABLED = false
    const session = putSession()
    recordConversation(session, humanEntry('報名截止日？'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(llm.completeText).not.toHaveBeenCalled()
  })
})

// ── livekit EOU 時機層 ────────────────────────────────────────────────────────

describe('interjection — livekit EOU 時機層', () => {
  beforeEach(() => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false
    mockEnv.INTERJECTION_TURN_DETECTOR = 'livekit'
  })

  it('EOU 判定講完 → 1s 就提早評估（不等滿 2.5s）', async () => {
    const session = putSession()
    eou.isEndOfTurn.mockResolvedValueOnce(true)
    recordConversation(session, humanEntry('報名截止日是什麼時候？'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(eou.isEndOfTurn).toHaveBeenCalledWith(
      [{ role: 'user', content: '報名截止日是什麼時候？' }],
      'zh',
      0.1,
    )
    expect(llm.completeText).toHaveBeenCalledTimes(1) // 提早評估已發生
  })

  it('EOU 判定沒講完 → 1s 不評估，補滿 2.5s 後 fallback 無條件評估', async () => {
    const session = putSession()
    eou.isEndOfTurn.mockResolvedValueOnce(false)
    recordConversation(session, humanEntry('我想問一下那個'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(llm.completeText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500) // remaining = 2500 - 1000
    expect(llm.completeText).toHaveBeenCalledTimes(1)
  })

  it('EOU 推論期間有新發言 → 本次評估作廢（由新發言的計時鏈接手）', async () => {
    const session = putSession()
    eou.isEndOfTurn.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 50)
      recordConversation(session, humanEntry('然後我還想說', '小華'))
      return true
    })
    recordConversation(session, humanEntry('報名截止日是？'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(llm.completeText).not.toHaveBeenCalled() // 作廢，沒有評估
  })
})

// ── 有人正在說話時不准插嘴 ────────────────────────────────────────────────────
//
// 逐字稿是**落後且成批**到達的：要等 VAD 判定靜音才定稿。用「多久沒有新逐字稿」
// 推論「這輪講完了」，會在別人換氣、下一段定稿還沒到的空檔誤判成冷場。
// speech_on/off 時間軸是即時的。

describe('有人正在說話 → 不插話、不破冰', () => {
  const BOT_ID = 'bot-ij-1'

  function speakingSession(overrides: Partial<MeetingSession> = {}) {
    const s = putSession(overrides)
    s.botSession!.providerMeetingId = BOT_ID
    return s
  }

  afterEach(() => clearSpeakerTimeline(BOT_ID))

  it('插話評估：有人開口未停 → 跳過，連決策模型都不問', async () => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false
    const session = speakingSession()
    llm.completeText.mockResolvedValue(decision({ interject: true, question: '報名日期' }))

    recordConversation(session, humanEntry('我覺得這個時程'))
    recordSpeechOn(BOT_ID, '小明', Date.now()) // 那個人還在講

    await vi.advanceTimersByTimeAsync(10_000)

    expect(llm.completeText).not.toHaveBeenCalled()
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('speech_off 之後的下一輪才會評估', async () => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false
    const session = speakingSession()

    recordConversation(session, humanEntry('我覺得這個時程'))
    recordSpeechOn(BOT_ID, '小明', Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(llm.completeText).not.toHaveBeenCalled()

    recordSpeechOff(BOT_ID, '小明', Date.now())
    recordConversation(session, humanEntry('有點趕'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(llm.completeText).toHaveBeenCalled()
  })

  it('破冰：有人正在說話 → 跳過並繼續監看', async () => {
    mockEnv.INTERJECTION_ENABLED = false
    mockEnv.ICEBREAKER_ENABLED = true
    mockEnv.ICEBREAKER_SILENCE_MS = 10_000 // 短於 MAX_OPEN_SPEECH_MS，才測得到「擋住」
    const session = speakingSession()
    recordSpeechOn(BOT_ID, '小明', Date.now())
    startIcebreaker(session)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(wwd.speakProactive).not.toHaveBeenCalled()

    recordSpeechOff(BOT_ID, '小明', Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    mockEnv.ICEBREAKER_SILENCE_MS = 40_000
  })

  // ── 2026-08-03 實機事故的兩條迴歸 ────────────────────────────────────────────

  it('漏收 speech_off → 最多擋 MAX_OPEN_SPEECH_MS，不會讓蜜塔永久失聲', async () => {
    mockEnv.INTERJECTION_ENABLED = false
    mockEnv.ICEBREAKER_ENABLED = true
    const session = speakingSession()
    recordSpeechOn(BOT_ID, '小明', Date.now()) // 之後永遠沒有 speech_off
    startIcebreaker(session)

    // 破冰門檻 40s > 30s 上限 → 第一次觸發時開放區間已過期，照樣開口
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
  })

  it('對話串開著時，human-speaking 不能擋掉「回答被問到的問題」', async () => {
    mockEnv.INTERJECTION_ENABLED = true
    mockEnv.ICEBREAKER_ENABLED = false
    // lastEngagedAt = 剛剛被叫過名字（「蜜塔」→ wake-only）→ 這一輪是追問
    const session = speakingSession({ lastEngagedAt: Date.now() })
    llm.completeText.mockResolvedValue(
      decision({ addressed: 'address', question: '競品比較', intent: 'factual' }),
    )

    recordConversation(session, humanEntry('我們的競品比較'))
    recordSpeechOn(BOT_ID, '小明', Date.now()) // 現場還有人在講話

    await vi.advanceTimersByTimeAsync(10_000)

    expect(wwd.answerFollowUp).toHaveBeenCalledTimes(1)
    expect(wwd.answerFollowUp.mock.calls[0][1]).toBe('競品比較')
  })
})
