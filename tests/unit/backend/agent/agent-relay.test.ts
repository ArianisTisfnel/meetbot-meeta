import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    AGENT_MODE: 'on',
    AGENT_PAGE_URL: 'https://front.test/agent',
    OPENAI_API_KEY: 'sk-test',
    RECALL_WEBHOOK_URL: 'https://hook.test',
    RECALL_WEBHOOK_TOKEN: 'secret',
  },
}))

import {
  handleTranscriptionEvent,
  isEchoOf,
  TRANSCRIPTION_PROMPT,
} from '../../../../backend/src/agent/agent-relay'
import {
  registerAgentSession,
  unregisterAgentSession,
  type AgentSession,
} from '../../../../backend/src/agent/agent-registry'

const AGENT_ID = 'agent-uuid-relay'
const BOT_ID = 'bot-relay'

function makeSession(): { session: AgentSession; onPartialSegment: ReturnType<typeof vi.fn>; onSegment: ReturnType<typeof vi.fn> } {
  const onPartialSegment = vi.fn()
  const onSegment = vi.fn()
  const session = registerAgentSession(AGENT_ID, BOT_ID, '蜜塔', { onPartialSegment, onSegment })
  return { session, onPartialSegment, onSegment }
}

describe('handleTranscriptionEvent（OpenAI 轉錄事件 → 既有 LiveHandlers）', () => {
  let ctx: ReturnType<typeof makeSession>
  let itemTexts: Map<string, string>

  beforeEach(() => {
    unregisterAgentSession(AGENT_ID)
    ctx = makeSession()
    itemTexts = new Map()
  })

  it('delta 依 item_id 累積成完整前綴 → onPartialSegment（喚醒 regex 要能命中「蜜塔」）', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '蜜',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '塔今天',
    })

    expect(ctx.onPartialSegment).toHaveBeenCalledTimes(2)
    const second = ctx.onPartialSegment.mock.calls[1][0]
    expect(second.text).toBe('蜜塔今天')
    expect(second.segmentId).toBe('agent-partial:item-1')
    expect(typeof second.startTime).toBe('number')
  })

  it('不同 item_id 各自累積，互不汙染', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: '第一句',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'b',
      delta: '第二句',
    })
    expect(ctx.onPartialSegment.mock.calls[0][0].text).toBe('第一句')
    expect(ctx.onPartialSegment.mock.calls[1][0].text).toBe('第二句')
  })

  it('completed → onSegment（定稿），並清掉該 item 的累積', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: '蜜塔今天議程',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: '蜜塔，今天議程是什麼？',
    })

    expect(ctx.onSegment).toHaveBeenCalledTimes(1)
    const seg = ctx.onSegment.mock.calls[0][0]
    expect(seg.text).toBe('蜜塔，今天議程是什麼？')
    expect(seg.segmentId).toBe('agent:item-1')
    expect(itemTexts.has('item-1')).toBe(false)
  })

  it('空白 delta / 空白 transcript → 不觸發 handlers', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'x',
      delta: '  ',
    })
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'x',
      transcript: '',
    })
    expect(ctx.onPartialSegment).not.toHaveBeenCalled()
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  it('未知事件型別 / error 事件 → 安全略過不丟錯', () => {
    expect(() => {
      handleTranscriptionEvent(ctx.session, itemTexts, { type: 'session.updated' })
      handleTranscriptionEvent(ctx.session, itemTexts, { type: 'error', error: { message: 'x' } })
      handleTranscriptionEvent(ctx.session, itemTexts, {})
    }).not.toThrow()
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  // 迴圈防護：混音「麥克風」收得到蜜塔自己的聲音，轉錄模型在靜音段也會把提示句吐回來。
  // 這兩種輸入若進到 handlers，喚醒詞會被自己觸發 → 蜜塔自問自答（實測 2026-07-22）。
  it('轉錄提示句被吐回來（模型回音）→ 不轉給 handlers', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'echo-prompt',
      // 回灌的轉錄不會帶原標點 → 用去標點的提示句模擬（比對是正規化後做的）
      transcript: TRANSCRIPTION_PROMPT.replace(/[，。、：]/g, ''),
    })
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  it('蜜塔剛說過的話從會議混音回灌 → 不轉給 handlers', () => {
    ctx.session.recentSpeech.push('好的，我收到了，正在查詢資料，請稍候。')
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'echo-self',
      transcript: '好的我收到了正在查詢資料請稍候', // 回灌轉錄不會帶標點
    })
    expect(ctx.onSegment).not.toHaveBeenCalled()
  })

  // 迴歸測試（2026-07-25）：定稿比說話晚 1.5–3 秒，使用者問完後蜜塔正在說「我收到了」，
  // 那句問題的定稿正好落在靜音窗裡。用「事件到達時間」判斷會把真問題丟掉 →
  // 蜜塔說收到卻沒有下文、聊天室也沒訊息。自身語音是在輸入端送靜音擋掉的，不是在這裡。
  it('靜音窗內到達的定稿（使用者問題的定稿慢於蜜塔開口）→ 照常轉給 handlers', () => {
    ctx.session.selfAudioGuardUntil = Date.now() + 5_000
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'late-final',
      transcript: '蜜塔，今天議程是什麼？',
    })
    expect(ctx.onSegment).toHaveBeenCalledTimes(1)
  })

  it('真人提問不受回音防護影響（不能因為防護而漏聽）', () => {
    ctx.session.recentSpeech.push('目前資料中提到的主要問題有 SEO 成效滯後與回購率下滑。')
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'human',
      transcript: '蜜塔，這季的行銷預算還剩多少？',
    })
    expect(ctx.onSegment).toHaveBeenCalledTimes(1)
  })

  // 轉錄模型常吐簡體；webhook 路徑早就轉繁（provider/normalize.ts），agent 串流路徑不能漏。
  it('轉錄結果一律轉繁體，英文與數字原樣保留', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'zh',
      transcript: '蜜塔，请问这次的 Q3 budget 是多少？',
    })
    expect(ctx.onSegment.mock.calls[0][0].text).toBe('蜜塔，請問這次的 Q3 budget 是多少？')
  })

  it('partial 累積時就轉繁體（喚醒詞比對看的是 partial）', () => {
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'zh-partial',
      delta: '蜜塔，请问',
    })
    expect(ctx.onPartialSegment.mock.calls[0][0].text).toBe('蜜塔，請問')
  })

  it('isEchoOf：片段回音算回音；短句與不相干內容不算（避免誤殺真人發言）', () => {
    expect(isEchoOf('與會者會喊蜜塔來提問', '這是一場會議，與會者會喊「蜜塔」來提問。')).toBe(true)
    expect(isEchoOf('蜜塔', TRANSCRIPTION_PROMPT)).toBe(false) // 只叫名字＝真的在喚醒
    expect(isEchoOf('這季的行銷預算還剩多少', TRANSCRIPTION_PROMPT)).toBe(false)
  })

  it('startTime 以 anchor 換算（barge-in 晚到防護依賴 sessionStartedAt + startTime ≈ 現在）', () => {
    ctx.session.anchorMs = Date.now() - 10_000 // admitted 於 10 秒前
    handleTranscriptionEvent(ctx.session, itemTexts, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'y',
      delta: '插話內容',
    })
    const seg = ctx.onPartialSegment.mock.calls[0][0]
    expect(seg.startTime).toBeGreaterThanOrEqual(9.9)
    expect(seg.startTime).toBeLessThan(11)
  })
})
