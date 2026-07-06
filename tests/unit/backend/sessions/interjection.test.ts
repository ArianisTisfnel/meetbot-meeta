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
import {
  recordConversation,
  startIcebreaker,
  clearInterjection,
} from '../../../../backend/src/sessions/interjection'
import {
  ICEBREAKER_OPENING_WITH_KB,
  ICEBREAKER_OPENING_NO_KB,
  ICEBREAKER_SUMMARY_SYSTEM,
  INTERJECTION_DECISION_SYSTEM,
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
    vexaMeetingId: 42,
    platform: 'google_meet',
    nativeMeetingId: 'abc-defg-hij',
    difyDatasetId: 'dataset-abc',
    creatorVexaToken: 'tok-123',
    isSpeaking: false,
    lastWakeAt: 0,
    wakePendingUntil: 0,
    wakePendingSpeaker: null,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    speechEndsAt: 0,
    chatLog: [],
    sessionStartedAt: 0,
    bargeEpoch: 0,
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  // 預設值還原（各 describe 的 beforeEach 再覆蓋）
  mockEnv.INTERJECTION_ENABLED = true
  mockEnv.INTERJECTION_TURN_DETECTOR = 'silence'
  mockEnv.ICEBREAKER_ENABLED = true
  llm.completeText.mockResolvedValue('{"interject": false, "question": ""}')
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
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, ICEBREAKER_OPENING_WITH_KB)
    expect(llm.completeText).not.toHaveBeenCalled() // 罐頭台詞不走 LLM
  })

  it('開場沉默（無知識庫）→ 用無 KB 版文案', async () => {
    const session = putSession({ difyDatasetId: null })
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, ICEBREAKER_OPENING_NO_KB)
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
    )
  })

  it('破冰後進入 5 分鐘冷卻：期間每 40s 到點都跳過，冷卻結束後才會再破冰', async () => {
    const session = putSession()
    startIcebreaker(session)
    await vi.advanceTimersByTimeAsync(40_000) // 第一次破冰
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(280_000) // 冷卻中（40s*7 次到點全跳過）
    expect(wwd.speakProactive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(80_000) // 冷卻已過 → 下一個 40s 到點觸發
    expect(wwd.speakProactive).toHaveBeenCalledTimes(2)
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
    expect(call.system).toBe(INTERJECTION_DECISION_SYSTEM)
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
    llm.completeText.mockResolvedValueOnce('{"interject": true, "question": "報名截止日是什麼時候"}')
    wwd.resolveAnswer.mockResolvedValueOnce('報名截止日是 6 月 30 日。')
    recordConversation(session, humanEntry('報名截止日是什麼時候？有人知道嗎'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.resolveAnswer).toHaveBeenCalledWith(session, '報名截止日是什麼時候', 'chat')
    expect(wwd.speakProactive).toHaveBeenCalledWith(session, '我補充一下：報名截止日是 6 月 30 日。')
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
  })

  it('決策 = 插話但查詢期間有人開口 → 改貼聊天室 💡（不搶話）', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce('{"interject": true, "question": "隊伍人數上限是多少"}')
    wwd.resolveAnswer.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 50) // 查詢期間時間前進，讓新發言的 at 可區分
      recordConversation(session, humanEntry('欸我想到另一件事', '小華'))
      return '每隊最多 5 人。'
    })
    recordConversation(session, humanEntry('隊伍人數上限是多少？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.sendChatBestEffort).toHaveBeenCalledWith(session, '💡 每隊最多 5 人。')
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('決策 = 插話但檢索沒中（哨兵句）→ 放棄投遞，冷卻照計', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce('{"interject": true, "question": "報名費多少"}')
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
    llm.completeText.mockResolvedValueOnce('{"interject": true, "question": "地點在哪"}')
    wwd.resolveAnswer.mockResolvedValueOnce('')
    recordConversation(session, humanEntry('比賽地點在哪？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(wwd.sendChatBestEffort).not.toHaveBeenCalled()
    expect(wwd.speakProactive).not.toHaveBeenCalled()
  })

  it('插話後 90s 冷卻：期間新的發言到點不再呼叫決策器', async () => {
    const session = putSession()
    llm.completeText.mockResolvedValueOnce('{"interject": true, "question": "截止日"}')
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

  it('喚醒問答剛結束（15s 靜默期）→ 不評估', async () => {
    const session = putSession()
    session.lastWakeAt = Date.now()
    recordConversation(session, humanEntry('剛剛那個答案的出處是？'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(llm.completeText).not.toHaveBeenCalled()
  })

  it('喚醒待命窗開著（wakePendingUntil 未過期）→ 不評估', async () => {
    const session = putSession()
    session.wakePendingUntil = Date.now() + 8_000
    recordConversation(session, humanEntry('請問報名日期'))
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
