/**
 * 離線會議模擬器（回報 2026-07-28 C 的第二層）。
 *
 * 用一支假的 bot provider 餵腳本進**完全真實的** session 管線
 * （wake-word-detector → 意圖分流 → Dify/逐字稿 QA → interjection/icebreaker），
 * 把蜜塔的每個動作連同時間戳記錄下來，最後印成時間軸。
 * 不開 Google Meet、不派 bot、不寫 DB，但走的是線上同一份程式碼。
 *
 * 與 eval-meeting.ts 的分工：
 *   eval-meeting  → 逐句判斷對不對（快、可斷言、適合當回歸閘門）
 *   simulate（本檔）→ 整場跑起來像不像（看時序、看實際講出來的話、看標籤對不對）
 *
 * 跑法（backend/ 目錄，需要完整 .env——會真的打 Dify 與 LLM）：
 *   npx tsx --env-file .env scripts/simulate-meeting.ts                      # 預設腳本
 *   npx tsx --env-file .env scripts/simulate-meeting.ts --script my.json
 *   npx tsx --env-file .env scripts/simulate-meeting.ts --speed 4            # 4 倍速播放
 *   npx tsx --env-file .env scripts/simulate-meeting.ts --dify <datasetId>   # 指定知識庫
 *   npx tsx --env-file .env scripts/simulate-meeting.ts --no-kb              # 走逐字稿 QA 路徑
 *
 * ⚠️ --speed 只壓縮**腳本播放**，不縮放系統裡任何以毫秒寫死或由 env 決定的門檻：
 *    喚醒 debounce（2s）、喚醒待命窗（8s）、破冰沉默（40s）、插話冷卻（90s）。
 *    因此 speed > 1 會系統性地改變行為，實測 6x 下：
 *      · 腳本裡相隔 8 秒的兩次提問被壓成 1.3 秒 → 第二題撞上 debounce 被吞掉
 *      · LLM 呼叫擠在一起 → Gemini 免費層 429，回應全變成「查詢時發生錯誤」
 *    **要判斷蜜塔的行為對不對，一律用預設的 1x。** speed > 1 只適合快速確認
 *    「腳本跑得起來、接線沒斷」，不可用來評估回應品質。
 *
 *    要在短腳本裡看到破冰，正確做法是調門檻而不是加速：
 *      ICEBREAKER_SILENCE_MS=8000 npx tsx --env-file .env scripts/simulate-meeting.ts
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBotProviderForSimulation } from '../src/provider/index.js'
import type {
  BotOptions,
  BotSession,
  LiveHandlers,
  MeetingBotProvider,
  TranscriptSegment,
} from '../src/provider/types.js'
import { activeSessions } from '../src/sessions/session-store.js'
import { buildLiveHandlers } from '../src/sessions/session-manager.js'
import { startIcebreaker, clearInterjection } from '../src/sessions/interjection.js'
import type { MeetingSession } from '../src/types/session.js'

// ── 腳本格式 ──────────────────────────────────────────────────────────────────

interface ScriptEvent {
  /** 會議開始起算的秒數。 */
  at: number
  speaker: string
  text: string
  /** 'voice'（預設，走逐字稿）或 'chat'（走會議聊天室）。 */
  channel?: 'voice' | 'chat'
  /**
   * 是否也送出 partial 片段（模擬 STT 講到一半就推送）。
   * 預設 true——partial 是快速 ack 與 barge-in 的來源，關掉就測不到那條路。
   */
  partial?: boolean
}
interface MeetingScript {
  name?: string
  events: ScriptEvent[]
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const SPEED = Number(flag('speed') ?? 1)
const NO_KB = args.includes('--no-kb')
const DATASET_ID = NO_KB ? null : flag('dify') ?? process.env.SIM_DIFY_DATASET_ID ?? null

const here = dirname(fileURLToPath(import.meta.url))
const script: MeetingScript = JSON.parse(
  readFileSync(resolve(here, flag('script') ?? 'simulated-meetings/default.json'), 'utf-8'),
)

// ── 記錄蜜塔做了什麼 ─────────────────────────────────────────────────────────

const startedAt = Date.now()
const rel = () => ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)

type Action = 'speak' | 'chat' | 'stop' | 'prime'
const timeline: Array<{ at: number; kind: 'human' | Action; who: string; text: string }> = []

function record(kind: 'human' | Action, who: string, text: string): void {
  timeline.push({ at: (Date.now() - startedAt) / 1000, kind, who, text })
}

const ICON: Record<'human' | Action, string> = {
  human: '🗣 ',
  speak: '🔊',
  chat: '💬',
  stop: '🤐',
  prime: '  ',
}

// ── 假 provider ───────────────────────────────────────────────────────────────
//
// 只需要實作上層真的會呼叫的方法。getTranscript 回傳模擬器自己累積的段落，
// 讓「逐字稿 QA」路徑（context / 無知識庫）拿得到真的會議內容。

const collectedSegments: TranscriptSegment[] = []

class SimulatedProvider implements MeetingBotProvider {
  readonly name = 'simulated'

  async join(_url: string, opts: BotOptions, _handlers: LiveHandlers): Promise<BotSession> {
    return {
      provider: this.name,
      platform: opts.platform,
      nativeMeetingId: opts.nativeMeetingId,
      providerMeetingId: 'sim-bot',
      adapter: this,
      state: {},
    }
  }

  async getTranscript(): Promise<TranscriptSegment[]> {
    return collectedSegments
  }

  async speak(_s: BotSession, text: string): Promise<void> {
    record('speak', '蜜塔', text)
    console.log(`${rel()}s ${ICON.speak} 蜜塔（語音）：${text}`)
  }

  async sendChat(_s: BotSession, text: string): Promise<void> {
    record('chat', '蜜塔', text)
    console.log(`${rel()}s ${ICON.chat} 蜜塔（聊天室）：${text}`)
  }

  async stopSpeaking(): Promise<void> {
    record('stop', '蜜塔', '（讓路，停止語音）')
    console.log(`${rel()}s ${ICON.stop} 蜜塔停止語音（barge-in 讓路）`)
  }

  async primeSpeech(): Promise<void> {
    /* 模擬器沒有 TTS 冷啟成本 */
  }

  async leave(): Promise<void> {
    /* no-op */
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const MEETING_ID = 'sim-meeting'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeSession(botSession: BotSession): MeetingSession {
  return {
    meetingInstanceId: MEETING_ID,
    vexaMeetingId: null,
    platform: 'google_meet',
    nativeMeetingId: 'sim-meeting-id',
    difyDatasetId: DATASET_ID,
    creatorVexaToken: 'sim-token',
    isSpeaking: false,
    lastWakeAt: 0,
    lastEngagedAt: 0,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    speechEndsAt: 0,
    bargeEpoch: 0,
    chatLog: [],
    sessionStartedAt: Date.now(),
    processedSegmentIds: new Set(),
    botSession,
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
  }
}

async function main() {
  const provider = new SimulatedProvider()
  setBotProviderForSimulation(provider)

  const botSession = await provider.join('https://meet.google.com/sim', {
    platform: 'google_meet',
    nativeMeetingId: 'sim-meeting-id',
  }, {})

  const session = makeSession(botSession)
  activeSessions.set(MEETING_ID, session)

  // 與線上完全相同的接線（buildLiveHandlers 由 session-manager 匯出，避免模擬器自己抄一份）
  const handlers = buildLiveHandlers(MEETING_ID)
  startIcebreaker(session)

  console.log(`\n━━━ 模擬會議：${script.name ?? '(未命名)'} ━━━`)
  console.log(`知識庫：${DATASET_ID ?? '（無 → 走逐字稿 QA）'}｜播放速度：${SPEED}x`)
  if (SPEED !== 1) {
    console.log(
      '\n⚠️  警告：--speed 只壓縮腳本播放，不縮放 debounce(2s)／待命窗(8s)／破冰／插話冷卻，\n' +
        '    也會把 LLM 呼叫擠在一起觸發免費層限流。本次結果**不可用來評估回應品質**，\n' +
        '    只能用來確認腳本跑得起來。要看真實行為請拿掉 --speed。',
    )
  }
  console.log('')

  let playedMs = 0
  for (const ev of script.events) {
    const targetMs = (ev.at * 1000) / SPEED
    if (targetMs > playedMs) {
      await sleep(targetMs - playedMs)
      playedMs = targetMs
    }

    record('human', ev.speaker, ev.text)
    console.log(`${rel()}s ${ICON.human}${ev.speaker}${ev.channel === 'chat' ? '（聊天室）' : ''}：${ev.text}`)

    if (ev.channel === 'chat') {
      handlers.onChat?.({ sender: ev.speaker, text: ev.text, timestamp: Date.now(), isFromBot: false })
      continue
    }

    const segmentId = `sim-${ev.at}-${ev.speaker}`
    const seg: TranscriptSegment = {
      segmentId,
      text: ev.text,
      speaker: ev.speaker,
      startTime: ev.at,
      endTime: ev.at + 2,
      language: 'zh',
    }
    collectedSegments.push(seg)

    // partial 先到（真實 STT 的行為）：喚醒快速 ack 與 barge-in 都靠它
    if (ev.partial !== false) {
      handlers.onPartialSegment?.({ ...seg, segmentId: `${segmentId}-partial` })
      await sleep(300 / SPEED)
    }
    handlers.onSegment?.(seg)
  }

  // 腳本放完後留一段觀察窗：等最後一題的答案落地、看破冰會不會觸發
  const tailMs = Number(flag('tail-ms') ?? 20_000)
  console.log(`\n（腳本播完，再觀察 ${tailMs / 1000} 秒讓非同步回應與破冰落地…）\n`)
  await sleep(tailMs)

  clearInterjection(MEETING_ID)
  activeSessions.delete(MEETING_ID)

  // ── 時間軸總結 ─────────────────────────────────────────────────────────────
  console.log('\n════════ 時間軸 ════════')
  for (const t of timeline) {
    console.log(`${t.at.toFixed(1).padStart(6)}s ${ICON[t.kind]} ${t.who}：${t.text}`)
  }

  const botActions = timeline.filter((t) => t.kind !== 'human')
  const spoken = botActions.filter((t) => t.kind === 'speak').length
  const chatted = botActions.filter((t) => t.kind === 'chat').length
  console.log(`\n蜜塔共出手 ${botActions.length} 次（語音 ${spoken}、聊天室 ${chatted}）`)
  console.log('檢查重點：有沒有沒被叫卻回應／該回應卻沉默／標籤跟實際走的路對不對。')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
