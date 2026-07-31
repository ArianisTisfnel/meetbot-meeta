import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// 喚醒詞偵測現在透過 provider 抽象層說話 / 發聊天室訊息（不再直接呼叫 vexaClient）。
const mockBotProvider = vi.hoisted(() => ({
  speak: vi.fn().mockResolvedValue(undefined),
  sendChat: vi.fn().mockResolvedValue(undefined),
  stopSpeaking: vi.fn().mockResolvedValue(undefined),
  getTranscript: vi.fn().mockResolvedValue([]),
}))

const NO_RESULT = '抱歉 沒有檢索到相關資訊'
const mockDify = vi.hoisted(() => ({
  askQuestion: vi.fn().mockResolvedValue({ answer: '測試回答', conversationId: 'conv-1' }),
  DIFY_NO_RESULT_SENTINEL: '抱歉 沒有檢索到相關資訊',
}))

vi.mock('../../../../backend/src/provider/index', () => ({ botProvider: mockBotProvider }))
vi.mock('../../../../backend/src/lib/dify', () => mockDify)
// 直接 mock lib/llm：原本只 mock @anthropic-ai/sdk，但 llm.ts 解析到 backend/node_modules
// 的實體套件，mock 從未生效（classify 路徑靠 catch 回退 factual 才沒炸）。
const mockCompleteText = vi.hoisted(() => vi.fn().mockResolvedValue('Claude 回答'))
// ⚠️ mock 必須把「被 import 的具名匯出」補齊。少一個常數不會噴明顯錯誤，
// 而是讓 classifyIntent 在呼叫 completeText **之前**就丟錯 → 被它自己的 catch
// 吞掉退回 factual → 排隊中的 mockRejectedValueOnce 沒被消耗，外溢污染後面的測試。
vi.mock('../../../../backend/src/lib/llm', () => ({
  completeText: mockCompleteText,
  CLASSIFY_LLM_TIMEOUT_MS: 3_000,
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}))
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DIFY_API_BASE: 'http://dify.test',
    DIFY_WORKFLOW_API_KEY: 'app-test',
    DIFY_CHATFLOW_TIMEOUT_MS: 45000,
  },
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Claude 回答' }],
      }),
    },
  })),
}))

import {
  handleTranscriptSegment,
  handlePartialSegment,
  handleChatMessage,
  handleBargeIn,
  parseIntent,
  cleanQuestion,
  preClassifyIntent,
  isFollowUpQuestion,
  isNoRetrievalAnswer,
  resolveAnswer,
  speakProactive,
  speechTiming,
} from '../../../../backend/src/sessions/wake-word-detector'

// 語音播放估時歸零：測試裡 speak 是即時 mock，不能真等「開場白唸完」的 3-6 秒
speechTiming.msPerChar = 0
speechTiming.extraMs = 0
speechTiming.floorMs = 0
import type { MeetingSession } from '../../../../backend/src/types/session'
import type { BotSession } from '../../../../backend/src/provider/types'

const fakeBotSession: BotSession = {
  provider: 'vexa',
  platform: 'google_meet',
  nativeMeetingId: 'abc-defg-hij',
  providerMeetingId: 42,
  adapter: mockBotProvider as any,
  state: {},
}

function makeSession(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    meetingInstanceId: 'meet-1',
    vexaMeetingId: 1,
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
    bargeEpoch: 0,
    speechGen: 0,
    activeSpeakers: new Set<string>(),
    chatLog: [],
    sessionStartedAt: 0,
    processedSegmentIds: new Set<string>(),
    botSession: fakeBotSession,
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
    ...overrides,
  }
}

describe('handleTranscriptSegment — 喚醒詞偵測', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('「蜜塔，請問這份規則是最新版嗎？」→ 觸發，question 正確', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-1',
      text: '蜜塔，請問這份規則是最新版嗎？',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「小幫手請問」→ 觸發（前置標點去除）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-2',
      text: '小幫手請問',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「Meeta, what is this?」→ 觸發（英文）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-3',
      text: 'Meeta, what is this?',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「蜜桃，請問報名日期」→ 觸發（STT 把「蜜塔」聽成「蜜桃」）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-peach',
      text: '蜜桃，請問報名日期',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('「mita 今天的議程」→ 觸發（小寫英文）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-4',
      text: 'mita 今天的議程',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).toHaveBeenCalled()
  })

  it('同一 segment_id 第二次 → 不觸發（processedSegmentIds 去重）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-dup',
      text: '蜜塔，重複測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    vi.clearAllMocks()

    await handleTranscriptSegment(session, {
      segment_id: 'seg-dup',
      text: '蜜塔，重複測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('2 秒內第二個觸發 → 被 debounce 阻止', async () => {
    const session = makeSession()
    session.lastWakeAt = Date.now() - 500  // 500ms 前剛觸發過

    await handleTranscriptSegment(session, {
      segment_id: 'seg-debounce',
      text: '蜜塔，debounce 測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('segment 無 segment_id → 不處理', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: '',  // 空字串視為無 ID
      text: '蜜塔，測試',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('processedSegmentIds 超過 5000 → 減半（size 約 2500）', async () => {
    const session = makeSession()
    // 填入 5000 個 ID
    for (let i = 0; i < 5000; i++) {
      session.processedSegmentIds.add(`seg-fill-${i}`)
    }
    expect(session.processedSegmentIds.size).toBe(5000)

    await handleTranscriptSegment(session, {
      segment_id: 'seg-trigger',
      text: '蜜塔，觸發減半',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })

    // 減半後加入新 ID，size 應約為 2501
    expect(session.processedSegmentIds.size).toBeLessThanOrEqual(2502)
    expect(session.processedSegmentIds.size).toBeGreaterThan(2400)
  })

  it('問題為空字串（只說了「蜜塔」）→ 不觸發 speak', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-empty',
      text: '蜜塔',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  // STT 會把停頓 finalize 成單一標點，接在喚醒詞後面就變成「問題＝『,』」，
  // 送去查詢只會得到一段跟現場完全無關的答案（實測 2026-07-22）。
  it('喚醒詞後只有標點（「蜜塔,」）→ 不派發問題', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'seg-punct',
      text: '蜜塔,',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('同一題 30 秒內重複進來 → 只回答一次（重複觸發防護）', async () => {
    const session = makeSession()
    await handleTranscriptSegment(session, {
      segment_id: 'rep-1',
      text: '蜜塔，報名日期是什麼時候',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    const callsAfterFirst = mockBotProvider.speak.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    session.lastWakeAt = 0 // 繞過 2 秒 debounce，單獨驗證「同一題」防護
    await handleTranscriptSegment(session, {
      segment_id: 'rep-2',
      text: '蜜塔，報名日期是什麼時候？',
      speaker: 'A',
      start_time: 10,
      end_time: 12,
    })
    expect(mockBotProvider.speak.mock.calls.length).toBe(callsAfterFirst)
  })

  it('ack 訊息：講者不明說「收到你的…」、有講者則帶名字（不再出現「收到的問題」）', async () => {
    const anon = makeSession()
    await handleTranscriptSegment(anon, {
      segment_id: 'ack-anon',
      text: '蜜塔，議程是什麼',
      speaker: '', // agent 串流轉錄是會議混音，沒有講者標記
      start_time: 1,
      end_time: 2,
    })
    const anonAck = mockBotProvider.sendChat.mock.calls.map((c) => c[1]).find((t: string) => t.startsWith('👂'))
    expect(anonAck).toContain('收到你的語音提問')

    vi.clearAllMocks()
    const named = makeSession()
    await handleTranscriptSegment(named, {
      segment_id: 'ack-named',
      text: '蜜塔，議程是什麼',
      speaker: 'Arianis',
      start_time: 1,
      end_time: 2,
    })
    const namedAck = mockBotProvider.sendChat.mock.calls.map((c) => c[1]).find((t: string) => t.startsWith('👂'))
    expect(namedAck).toContain('收到 Arianis 的語音提問')
  })

  it('語音提問用 👂、聊天室打字提問用 💬（一眼分辨來源）', async () => {
    const voice = makeSession()
    await handleTranscriptSegment(voice, {
      segment_id: 'icon-voice',
      text: '蜜塔，報名日期是什麼時候',
      speaker: 'A',
      start_time: 1,
      end_time: 2,
    })
    const voiceAck = mockBotProvider.sendChat.mock.calls.map((c) => c[1]).find((t: string) => t.includes('收到'))
    expect(voiceAck.startsWith('👂')).toBe(true)
    expect(voiceAck).toContain('語音提問')

    vi.clearAllMocks()
    const chat = makeSession()
    await handleChatMessage(chat, {
      sender: 'Bob',
      text: '蜜塔，報名日期是什麼時候',
      timestamp: Date.now(),
      is_from_bot: false,
    })
    const chatAck = mockBotProvider.sendChat.mock.calls.map((c) => c[1]).find((t: string) => t.includes('收到'))
    expect(chatAck.startsWith('💬')).toBe(true)
    expect(chatAck).toContain('收到 Bob 的文字提問')
  })
})

describe('preClassifyIntent — 規則先行的意圖判定', () => {
  // 這兩類問題 LLM 分類器最常誤判，改用字面規則定案（也省一次 LLM 呼叫）。
  it('對蜜塔本人說的話 → chitchat（不會被知識庫的「主要問題」帶去 factual）', () => {
    expect(preClassifyIntent('你到底有什麼問題')).toBe('chitchat')
    expect(preClassifyIntent('你還在嗎')).toBe('chitchat')
    expect(preClassifyIntent('你是誰')).toBe('chitchat')
    expect(preClassifyIntent('你怎麼不說話')).toBe('chitchat')
    expect(preClassifyIntent('蜜塔是誰')).toBe('chitchat')
  })

  it('純寒暄 → chitchat；寒暄後面接真問題則不算', () => {
    expect(preClassifyIntent('你好')).toBe('chitchat')
    expect(preClassifyIntent('謝謝！')).toBe('chitchat')
    expect(preClassifyIntent('hello')).toBe('chitchat')
    expect(preClassifyIntent('謝謝，那報名日期是什麼時候')).toBeNull()
  })

  it('會議脈絡問題 → context（查文件永遠答不出來）', () => {
    expect(preClassifyIntent('剛才是誰在問簡報格式')).toBe('context')
    expect(preClassifyIntent('我們剛剛討論的結論是什麼')).toBe('context')
    expect(preClassifyIntent('總結一下目前的進度')).toBe('context')
    expect(preClassifyIntent('誰負責行銷這塊')).toBe('context')
  })

  it('一般事實題 → null（交給 LLM 分類器判斷）', () => {
    expect(preClassifyIntent('報名日期是什麼時候')).toBeNull()
    expect(preClassifyIntent('今年的行銷預算是多少')).toBeNull()
    expect(preClassifyIntent('你覺得這個時程合理嗎')).toBeNull()
  })

  // 實測 2026-07-25：「我肚子餓了。」被送去查專案資料。
  it('與工作無關的個人狀態 → chitchat；但開頭同樣是「我們」的事實題不受影響', () => {
    expect(preClassifyIntent('我肚子餓了。')).toBe('chitchat')
    expect(preClassifyIntent('我好累喔')).toBe('chitchat')
    expect(preClassifyIntent('哈哈哈')).toBe('chitchat')
    expect(preClassifyIntent('我們累積了多少報名人數')).toBeNull()
    expect(preClassifyIntent('我想知道預算還剩多少')).toBeNull()
  })
})

describe('isFollowUpQuestion — 省略主詞的接續追問', () => {
  it('「那X呢」形式才算；完整問句不算', () => {
    expect(isFollowUpQuestion('那 Beta 呢')).toBe(true)
    expect(isFollowUpQuestion('決賽呢？')).toBe(true)
    expect(isFollowUpQuestion('報名日期是什麼時候')).toBe(false)
    expect(isFollowUpQuestion('那我們要怎麼處理這件事呢，我覺得可以再討論')).toBe(false)
  })
})

describe('parseIntent — 分類器輸出解析', () => {
  it('單一類別詞（正常輸出）', () => {
    expect(parseIntent('chitchat')).toBe('chitchat')
    expect(parseIntent(' Factual\n')).toBe('factual')
    expect(parseIntent('**hybrid**')).toBe('hybrid')
  })

  it('模型多話時取最後出現的類別（否定句用第一個會解錯）', () => {
    expect(parseIntent('這不是 chitchat，是 factual')).toBe('factual')
    expect(parseIntent('分類：context')).toBe('context')
  })

  it('空字串／認不出來 → factual（LLM 掛掉時 RAG 是唯一還能作答的路徑）', () => {
    expect(parseIntent('')).toBe('factual')
    expect(parseIntent('???')).toBe('factual')
  })
})

describe('resolveAnswer — 路由正確性（Dify 查詢 / 閒聊 / 會議脈絡）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('寒暄不查資料也不翻逐字稿（沒有知識庫的會議也一樣）', async () => {
    const noKb = makeSession({ difyDatasetId: null })
    await resolveAnswer(noKb, '你好嗎', 'voice')
    expect(mockDify.askQuestion).not.toHaveBeenCalled()
    expect(mockBotProvider.getTranscript).not.toHaveBeenCalled()
  })

  it('「剛才誰說的」走會議脈絡，不進 Dify', async () => {
    const session = makeSession()
    await resolveAnswer(session, '剛才是誰在問簡報格式', 'voice')
    expect(mockDify.askQuestion).not.toHaveBeenCalled()
    expect(mockBotProvider.getTranscript).toHaveBeenCalled()
  })

  it('事實題走 Dify', async () => {
    const session = makeSession()
    const answer = await resolveAnswer(session, '報名日期是什麼時候', 'voice')
    expect(mockDify.askQuestion).toHaveBeenCalledTimes(1)
    expect(answer).toBe('測試回答')
  })

  // 知識庫查不到就把哨兵句唸出來 = 使用者聽到「抱歉 沒有檢索到相關資訊」，
  // 但答案其實常常就在剛才的討論裡。
  it('知識庫沒檢索到 → 喚醒詞問答改用會議脈絡回答（不唸哨兵句）', async () => {
    const session = makeSession()
    mockDify.askQuestion.mockResolvedValueOnce({ answer: NO_RESULT, conversationId: 'conv-1' })
    const answer = await resolveAnswer(session, '報名日期是什麼時候', 'voice', { onKbMiss: 'context' })
    expect(mockBotProvider.getTranscript).toHaveBeenCalled()
    expect(answer).not.toBe(NO_RESULT)
  })

  it('知識庫沒檢索到 → 插話路徑（預設）維持哨兵句，讓決策層自己放棄插話', async () => {
    const session = makeSession()
    mockDify.askQuestion.mockResolvedValueOnce({ answer: NO_RESULT, conversationId: 'conv-1' })
    const answer = await resolveAnswer(session, '報名日期是什麼時候', 'chat')
    expect(answer).toBe(NO_RESULT)
  })

  it('沒有知識庫時規則沒中 → 直接走逐字稿，不浪費一次 LLM 分類呼叫', async () => {
    const noKb = makeSession({ difyDatasetId: null })
    mockCompleteText.mockClear()
    await resolveAnswer(noKb, '報名日期是什麼時候', 'voice')
    expect(mockBotProvider.getTranscript).toHaveBeenCalled()
    const classifierCalls = mockCompleteText.mock.calls.filter((c) =>
      String(c[0]?.system).includes('問題路由器'),
    )
    expect(classifierCalls).toHaveLength(0)
  })

  // 「那 Beta 呢」單看一句，分類器常判成 context → 拿逐字稿回答查得到的事實題。
  it('接續追問沿用上一題的路徑（不重新分類）', async () => {
    const session = makeSession()
    await resolveAnswer(session, '報名日期是什麼時候', 'voice') // factual
    expect(session.lastIntent).toBe('factual')

    mockCompleteText.mockClear()
    mockDify.askQuestion.mockClear()
    await resolveAnswer(session, '那決賽呢', 'voice')
    expect(mockDify.askQuestion).toHaveBeenCalledTimes(1) // 仍走 Dify
    expect(mockCompleteText).not.toHaveBeenCalled() // 沒有再問一次分類器
  })

  it('LLM 分類失敗 → 退回 factual（Dify 是唯一還能作答的路徑），閒聊仍由規則層擋住', async () => {
    const session = makeSession()
    mockCompleteText.mockRejectedValueOnce(new Error('429 quota exceeded'))
    await resolveAnswer(session, '報名日期是什麼時候', 'voice')
    expect(mockDify.askQuestion).toHaveBeenCalledTimes(1)

    // 分類器完全不可用時，「我肚子餓了」也不會被送去查專案資料
    mockDify.askQuestion.mockClear()
    mockCompleteText.mockRejectedValueOnce(new Error('429 quota exceeded'))
    await resolveAnswer(session, '我肚子餓了。', 'voice')
    expect(mockDify.askQuestion).not.toHaveBeenCalled()
  })
})

describe('isNoRetrievalAnswer — 知識庫沒檢索到', () => {
  it('哨兵句與空答案算沒檢索到；正常答案不算', () => {
    expect(isNoRetrievalAnswer('抱歉 沒有檢索到相關資訊')).toBe(true)
    expect(isNoRetrievalAnswer('   ')).toBe(true)
    expect(isNoRetrievalAnswer('報名日期是 8 月 1 日')).toBe(false)
  })
})

describe('cleanQuestion — 問題內容清理', () => {
  it('只有標點 / 太短 → 空字串（不是問題）', () => {
    expect(cleanQuestion(',')).toBe('')
    expect(cleanQuestion('？？？')).toBe('')
    expect(cleanQuestion('  …  ')).toBe('')
  })

  it('去掉開頭殘留標點、壓平換行', () => {
    expect(cleanQuestion('」（請問報名日期')).toBe('請問報名日期')
    expect(cleanQuestion('  請問\n報名日期  ')).toBe('請問 報名日期')
  })

  it('正常問題原樣保留', () => {
    expect(cleanQuestion('今年的行銷預算是多少？')).toBe('今年的行銷預算是多少？')
  })
})

describe('handlePartialSegment — partial 快速喚醒', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('partial 已聽到問題內容 → 立即說開場白；同句重複 partial 在抑制期內只 ack 一次', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔可以告訴我', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1)

    await handlePartialSegment(session, { text: '蜜塔可以告訴我報名日期嗎', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1)
  })

  // 開口＝靜音收音（混音麥克風會錄到蜜塔自己）。在「蜜塔」兩個字就搶答，
  // 會把問題後半段吃掉 → 使用者只聽到「我收到了」然後沒有下文（實測 2026-07-25）。
  it('partial 只叫到名字、問題還沒講 → 先不 ack（等聽到問題內容才開口）', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()

    await handlePartialSegment(session, { text: '蜜塔，請', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()

    await handlePartialSegment(session, { text: '蜜塔，請問報名', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1)
  })

  it('partial 無喚醒詞 → 不動作', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '今天天氣不錯', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  // 句中提到蜜塔不是在叫她：舊版用不設限的喚醒詞比對，會先喊一句「我收到了」，
  // 定稿判定不是問題後就沒下文 → 看起來像蜜塔一直在亂應聲。
  it('partial 只是句中提到蜜塔（非指名）→ 不 ack', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '大家覺得蜜塔剛剛說的對嗎', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })

  it('partial ack 後 final 派發 → 跳過開場白（ack + 答案共 2 次 speak）', async () => {
    const session = makeSession()
    await handlePartialSegment(session, { text: '蜜塔請問今天的', speaker: 'A' })
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(1) // 開場白（提早）

    await handleTranscriptSegment(session, {
      segment_id: 'seg-final',
      text: '蜜塔請問今天的議程是什麼',
      speaker: 'A',
      start_time: 1,
      end_time: 3,
    })
    // final 跳過開場白、只說答案 → 總共 2 次（未跳過會是 3 次）
    expect(mockBotProvider.speak).toHaveBeenCalledTimes(2)
    expect(session.partialAckAt).toBe(0) // 一次性消耗
  })

  it('bot 正在說話（isSpeaking）→ 不 ack', async () => {
    const session = makeSession({ isSpeaking: true })
    await handlePartialSegment(session, { text: '蜜塔請問', speaker: 'A' })
    expect(mockBotProvider.speak).not.toHaveBeenCalled()
  })
})

describe('語音問題但嘴巴被佔用 → 改走聊天室', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('isSpeaking 時的語音喚醒 → 不 speak，答案走 sendChat（含 👂 確認）', async () => {
    const session = makeSession({ isSpeaking: true })
    await handleTranscriptSegment(session, {
      segment_id: 'seg-busy',
      text: '蜜塔，報名費是多少',
      speaker: 'B',
      start_time: 1,
      end_time: 2,
    })

    expect(mockBotProvider.speak).not.toHaveBeenCalled()
    // 👂 確認 + 答案 = 至少兩次 sendChat
    expect(mockBotProvider.sendChat.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockBotProvider.sendChat.mock.calls[0][1]).toContain('👂')
    expect(mockBotProvider.sendChat.mock.calls[0][1]).toContain('B')
  })
})

describe('parseIntent — 問答意圖分流', () => {
  it('chitchat / factual / context / hybrid 關鍵字正確解析', () => {
    expect(parseIntent('chitchat')).toBe('chitchat')
    expect(parseIntent('factual')).toBe('factual')
    expect(parseIntent('context')).toBe('context')
    expect(parseIntent('hybrid')).toBe('hybrid')
    expect(parseIntent('這是閒聊')).toBe('chitchat')
    expect(parseIntent('寒暄')).toBe('chitchat')
    expect(parseIntent('這是意見型問題')).toBe('context')
    expect(parseIntent('混合')).toBe('hybrid')
  })

  it('未知輸出 → 回退 factual（保持原 RAG 行為）', () => {
    expect(parseIntent('Claude 回答')).toBe('factual')
    expect(parseIntent('')).toBe('factual')
  })
})

describe('handleBargeIn — 說話中被打斷讓路', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('蜜塔說話中有人講話 → 停止語音、被打斷的回答貼聊天室、isSpeaking 解除', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '這是被打斷的答案' })
    await handleBargeIn(session, { text: '等一下我有意見', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.isSpeaking).toBe(false)
    expect(session.bargeEpoch).toBe(1)
    // 讓路後進入喚醒靜默期：抑制插話引擎把打斷者的話當新問題重複回答
    expect(session.lastWakeAt).toBeGreaterThan(0)
    expect(mockBotProvider.sendChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('這是被打斷的答案'),
    )
  })

  it('STT 晚到事件：開口時間早於蜜塔開始說話 → 不算打斷', async () => {
    const base = Date.now() - 100_000
    const session = makeSession({
      isSpeaking: true,
      currentSpeech: '答案',
      sessionStartedAt: base,       // 會議 base 開始
      speechStartedAt: base + 60_000, // 蜜塔在第 60 秒開口
    })
    // 使用者在第 50 秒開口（蜜塔還沒說話），事件晚到
    await handleBargeIn(session, { text: '我想知道供應鏈狀況', speaker: 'A', startTime: 50 })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.isSpeaking).toBe(true)
  })

  it('明確停止指令（閉嘴）→ 即使很短也停止，且不轉貼被打斷內容', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '被打斷的答案' })
    await handleBargeIn(session, { text: '閉嘴', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.isSpeaking).toBe(false)
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('短附和（嗯嗯）→ 不觸發讓路', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '答案' })
    await handleBargeIn(session, { text: '嗯嗯', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.isSpeaking).toBe(true)
  })

  it('蜜塔沒在說話 → 不動作', async () => {
    const session = makeSession({ isSpeaking: false })
    await handleBargeIn(session, { text: '這是一般發言內容', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).not.toHaveBeenCalled()
    expect(session.bargeEpoch).toBe(0)
  })

  it('重複打斷訊號 → 只讓路一次（isSpeaking 已翻false）', async () => {
    const session = makeSession({ isSpeaking: true, currentSpeech: '答案' })
    await handleBargeIn(session, { text: '等一下我有意見', speaker: 'A' })
    await handleBargeIn(session, { text: '等一下我有意見喔', speaker: 'A' })

    expect(mockBotProvider.stopSpeaking).toHaveBeenCalledTimes(1)
    expect(session.bargeEpoch).toBe(1)
  })
})

describe('answerFromTranscript — 純文字會議的脈絡來源', () => {
  beforeEach(() => vi.clearAllMocks())

  it('無知識庫＋逐字稿為空：context 從 chatLog 取得（不再「內容不足」）', async () => {
    const session = makeSession({
      difyDatasetId: null,
      chatLog: [
        { speaker: '小明', text: '我們決定用 A 方案', at: Date.now() - 60_000 },
        { speaker: '小華', text: '好，預算抓 50 萬', at: Date.now() - 30_000 },
      ],
    })
    mockBotProvider.getTranscript.mockResolvedValueOnce([])
    await handleChatMessage(session, {
      sender: '小明',
      text: '蜜塔 我們剛剛的結論是什麼？',
      is_from_bot: false,
    } as any)
    const texts = mockBotProvider.sendChat.mock.calls.map((c: any[]) => String(c[1]))
    expect(texts.some((t) => t.includes('Claude 回答'))).toBe(true)
    expect(texts.some((t) => t.includes('還沒有足夠'))).toBe(false)
  })

  // 註：「chatLog 完全為空」的防禦分支在聊天流程中實際到不了——
  // dispatchQuestion 會先把「收到你的問題…」ack 記進 chatLog，context 永遠至少有一句。
})

describe('handleChatMessage — 聊天室喚醒詞', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('聊天室輸入 is_from_bot: true → 不處理', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'Bot',
      text: '蜜塔，Bot 自己說的',
      timestamp: Date.now(),
      is_from_bot: true,
    })
    expect(mockBotProvider.sendChat).not.toHaveBeenCalled()
  })

  it('聊天室正常觸發 → 呼叫 sendChat', async () => {
    const session = makeSession()
    await handleChatMessage(session, {
      sender: 'User',
      text: '蜜塔，這份文件是什麼？',
      timestamp: Date.now(),
      is_from_bot: false,
    })
    expect(mockBotProvider.sendChat).toHaveBeenCalled()
  })
})

// ── isSpeaking 世代鎖 ─────────────────────────────────────────────────────────
//
// speak() 送出即返回、播放結束沒有事件可等 → 解鎖全靠 setTimeout 估時。
// 這組測試釘住兩件事：
//   ① 查詢比安全網久時，答案播放期間仍持有嘴巴（安全網到期後要重新佔用）
//   ② 已作廢的語音，其解鎖計時器不能把新的一段語音解鎖
// 兩者失守的症狀都是「蜜塔講到一半就聽不見了」：barge-in 第一行檢查 isSpeaking
// 直接 return、新問題誤走語音分支疊在舊答案上。

describe('isSpeaking 世代鎖（嘴巴佔用的生命週期）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    // 還原檔頭的歸零設定，不影響其他 describe
    speechTiming.msPerChar = 0
    speechTiming.extraMs = 0
    speechTiming.floorMs = 0
  })

  it('查詢比安全網久 → 答案播放期間仍持有嘴巴', async () => {
    vi.useFakeTimers()
    // 給語音一個真實長度，才有「安全網先到期、答案後到」的時間差
    speechTiming.floorMs = 5_000

    const session = makeSession()

    // Dify 卡住直到手動放行（模擬實測的 15-20 秒查詢）
    let releaseDify: (v: unknown) => void = () => {}
    mockDify.askQuestion.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseDify = resolve
      }),
    )

    const pending = handleTranscriptSegment(session, {
      segment_id: 'seg-slow-query',
      text: '蜜塔，報名費是多少',
      speaker: 'B',
      start_time: 1,
      end_time: 2,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(session.isSpeaking).toBe(true)

    // 前進超過安全網（DIFY_CHATFLOW_TIMEOUT_MS 45s + 開場白 5s + 10s 餘裕）
    await vi.advanceTimersByTimeAsync(70_000)

    // 查詢終於回來 → 答案開始播放
    releaseDify({ answer: '報名費是 500 元', conversationId: 'conv-1' })
    await vi.advanceTimersByTimeAsync(0)
    await pending

    // 修正前：安全網已解鎖，且答案路徑沒有重新佔用 → 這裡會是 false
    expect(session.isSpeaking).toBe(true)
    expect(session.currentSpeech).toBe('報名費是 500 元')
  })

  it('已作廢語音的解鎖計時器，不會解鎖新的一段語音', async () => {
    vi.useFakeTimers()
    speechTiming.msPerChar = 100

    const session = makeSession()

    // 第一段：3 字 → 解鎖排在 300ms
    await speakProactive(session, '第一段')
    expect(session.isSpeaking).toBe(true)

    // 被打斷 → 這段作廢（speechGen++）
    await handleBargeIn(session, { text: '等一下我有問題', speaker: 'B' })
    expect(session.isSpeaking).toBe(false)

    // 第二段：20 字 → 解鎖排在 2000ms
    await speakProactive(session, '第二段'.padEnd(20, '啊'))
    expect(session.isSpeaking).toBe(true)

    // 走到「第一段」原定的解鎖時刻：它已作廢，不該影響第二段
    await vi.advanceTimersByTimeAsync(500)
    expect(session.isSpeaking).toBe(true)

    // 第二段自己的解鎖時刻到了才放開
    await vi.advanceTimersByTimeAsync(1_600)
    expect(session.isSpeaking).toBe(false)
  })
})
