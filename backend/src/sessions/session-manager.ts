import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import { botProvider } from '../provider/index.js'
import type { BotSession, LiveHandlers } from '../provider/types.js'
import { activeSessions } from './session-store.js'
import {
  handleTranscriptSegment,
  handlePartialSegment,
  handleChatMessage,
  handleBargeIn,
  PENDING_VOICES,
  ERROR_VOICE,
  PROGRESS_VOICES,
} from './wake-word-detector.js'
import { recordConversation, clearInterjection, startIcebreaker, noteHumanSpeaking } from './interjection.js'
import { generateSummaryAsync, trackSummary } from './summary.service.js'
import type { MeetingSession } from '../types/session.js'

const PLATFORM = 'google_meet'

// ── 歡迎訊息 ───────────────────────────────────────────────────────────────────

function welcomeMessage(difyDatasetId: string | null): string {
  return difyDatasetId
    ? '嗨大家好！我是蜜塔（Meeta），你們今天的會議小幫手 🎉\n\n你可以用語音或聊天室呼叫我：\n  語音：說「蜜塔」或「小幫手」，再接上你的問題\n  聊天室：輸入「蜜塔」或「小幫手」，再接上你的問題\n\n我會根據此專案上傳的資料來回答問題，例如：\n「蜜塔，請問去年 Q3 目標是什麼？」\n\n有問題就找我！'
    : '嗨大家好！我是蜜塔（Meeta），你們今天的會議小幫手 🎉\n\n你可以用語音或聊天室呼叫我：\n  語音：說「蜜塔」或「小幫手」，再接上你的問題\n  聊天室：輸入「蜜塔」或「小幫手」，再接上你的問題\n\n我會根據本次會議的逐字稿記錄來回答問題，例如：\n「蜜塔，剛才提到的時程安排是什麼？」\n\n有問題就找我！'
}

// ── 知識庫內容卡 ──────────────────────────────────────────────────────────────
//
// 把專案內「已索引完成」文件的摘要卡（indexing-poller 產生的 contentCard）
// 組成清單掛在 session 上。意圖分類器（classifyIntent）靠它判斷問題是否
// 與知識庫相關，避免「今年銷售多少」在知識庫沒有銷售資料時仍被分成 factual。
// 摘要卡還沒產出來時（poller 尚未跑到）退回只列文件名稱。

/** 注入分類器 prompt 的內容卡總長上限（字元）。 */
const KB_CARD_MAX_CHARS = 2000

async function loadKbContentCard(session: MeetingSession, difyDatasetId: string): Promise<void> {
  try {
    const materials = await prisma.material.findMany({
      where: { project: { difyDatasetId }, indexingStatus: 'COMPLETED', deletedAt: null },
      select: { displayName: true, contentCard: true },
      orderBy: { uploadedAt: 'desc' },
      take: 30,
    })
    const lines = materials.map((m) =>
      m.contentCard ? `【${m.displayName}】${m.contentCard}` : `【${m.displayName}】`,
    )
    session.kbContentCard = lines.length ? lines.join('\n').slice(0, KB_CARD_MAX_CHARS) : null
    logger.info(
      {
        meetingInstanceId: session.meetingInstanceId,
        docCount: materials.length,
        withCard: materials.filter((m) => m.contentCard).length,
      },
      'kb content card loaded',
    )
  } catch (err) {
    logger.warn(
      { err, meetingInstanceId: session.meetingInstanceId },
      'kb content card load failed (non-fatal, classifier runs without it)',
    )
  }
}

// ── startBotSession ─────────────────────────────────────────────────────────
//
// 取代舊的 createSession：透過 provider 抽象層派 bot，
// 在背景等待 bot 被 admitted。**不阻塞 HTTP 呼叫端**（createMeeting 立即回 PENDING）：
//   - admitted（join resolve）→ DB 轉 ACTIVE、發歡迎訊息
//   - 兩個 provider 都進不去（join reject）→ DB 轉 FAILED
//
// 此函式自身吞掉所有錯誤、永不 throw，呼叫端以 `void startBotSession(...)` 觸發。

export async function startBotSession(params: {
  meetingInstanceId: string
  googleMeetUrl: string
  nativeMeetingId: string
  difyDatasetId: string | null
  initialProcessedIds?: Set<string>
}): Promise<void> {
  const { meetingInstanceId, googleMeetUrl, nativeMeetingId, difyDatasetId } = params

  // 先把 MeetingSession 放進 Map，讓 live handlers（admitted 前可能就有事件）能查到它。
  const session: MeetingSession = {
    meetingInstanceId,
    platform: PLATFORM,
    nativeMeetingId,
    difyDatasetId,
    isSpeaking: false,
    lastWakeAt: 0,
    lastEngagedAt: 0,
    engagedSpeaker: null,
    speechPausedMs: 0,
    pendingBargeIn: null,
    partialAckAt: 0,
    currentSpeech: null,
    speechStartedAt: 0,
    speechEndsAt: 0,
    bargeEpoch: 0,
    lastStopAt: 0,
    speechGen: 0,
    chatLog: [],
    sessionStartedAt: 0,
    processedSegmentIds: params.initialProcessedIds ?? new Set(),
    botSession: null,
    difyConversationId: null,
    lastQuestionAt: 0,
    kbContentCard: null,
  }
  activeSessions.set(meetingInstanceId, session)

  // 內容卡 v0：背景載入知識庫文件名稱清單供意圖分類器參考（失敗不影響開會）
  if (difyDatasetId) void loadKbContentCard(session, difyDatasetId)

  const handlers = buildLiveHandlers(meetingInstanceId)

  try {
    const botSession = await botProvider.join(
      googleMeetUrl,
      { platform: PLATFORM, nativeMeetingId, difyDatasetId },
      handlers,
    )

    // 可能在等待期間已被取消（closeSession 從 Map 移除）→ 立即收掉剛 admitted 的 bot。
    const still = activeSessions.get(meetingInstanceId)
    if (!still) {
      await botProvider.leave(botSession).catch(() => {})
      return
    }
    still.botSession = botSession
    still.sessionStartedAt = Date.now()

    await prisma.meetingInstance.update({
      where: { id: meetingInstanceId },
      data: {
        status: 'ACTIVE',
        startedAt: new Date(),
        nativeMeetingId,
      },
    })

    logger.info({ meetingInstanceId, provider: botSession.provider }, 'Bot admitted → meeting ACTIVE')

    // 歡迎訊息（best-effort；provider 不支援聊天室時容錯）。
    if (botSession.adapter.sendChat) {
      botSession.adapter
        .sendChat(botSession, welcomeMessage(difyDatasetId))
        .catch((err) => logger.warn({ err, meetingInstanceId }, 'welcome chat failed (best-effort)'))
    }

    // 預熱固定台詞的 TTS（fire-and-forget）：把「我收到了」等句的合成成本
    // 移到 join 後閒置期，首次喚醒的回應延遲省 1–3 秒。
    botSession.adapter
      .primeSpeech?.(botSession, [...PENDING_VOICES, ERROR_VOICE, ...PROGRESS_VOICES])
      ?.catch((err) => logger.warn({ err, meetingInstanceId }, 'primeSpeech failed (best-effort)'))

    // 沉默破冰：進場即開始監看（開場沒人講話也會觸發）
    startIcebreaker(still)
  } catch (err) {
    // 兩個 provider 都無法讓 bot 進會議。
    logger.warn({ err, meetingInstanceId }, 'startBotSession: all providers failed to admit bot')
    activeSessions.delete(meetingInstanceId)
    await prisma.meetingInstance
      .update({ where: { id: meetingInstanceId }, data: { status: 'FAILED', endedAt: new Date() } })
      .catch((e) => logger.error({ e, meetingInstanceId }, 'failed to mark meeting FAILED'))
  }
}

/**
 * Live stream 事件 → 喚醒／插話／逐字稿留痕的接線。
 *
 * 獨立成函式的理由：離線會議模擬器（scripts/simulate-meeting.ts）要用**完全相同**的
 * 接線去餵腳本，否則模擬的行為會跟線上悄悄分岔（例如漏接 barge-in 或 recordConversation，
 * 模擬就測不到破冰計時）。
 */
export function buildLiveHandlers(meetingInstanceId: string): LiveHandlers {
  return {
    onSegment: (seg) => {
      const s = activeSessions.get(meetingInstanceId)
      if (!s || !s.botSession) return
      if (!seg.text?.trim() || !seg.segmentId) return
      // 蜜塔說話中有人開口 → 讓路（barge-in）；帶 startTime 供晚到事件判斷
      handleBargeIn(s, { text: seg.text, speaker: seg.speaker ?? '', startTime: seg.startTime }).catch((err) =>
        logger.error({ err, meetingInstanceId }, 'handleBargeIn error'),
      )
      handleTranscriptSegment(s, {
        segment_id: seg.segmentId,
        text: seg.text,
        speaker: seg.speaker ?? '',
        start_time: seg.startTime,
        end_time: seg.endTime,
      }).catch((err) =>
        logger.error({ err, meetingInstanceId }, 'handleTranscriptSegment error'),
      )
      recordConversation(s, {
        speaker: seg.speaker ?? '',
        text: seg.text,
        source: 'voice',
        fromBot: false, // bot 自己的語音已在 provider 層過濾
        at: Date.now(),
      })
    },
    onPartialSegment: (seg) => {
      const s = activeSessions.get(meetingInstanceId)
      if (!s || !s.botSession) return
      if (!seg.text?.trim()) return
      // partial 比 final 早 1.5-3 秒 → 讓路反應最快；帶 startTime 供晚到事件判斷
      handleBargeIn(s, { text: seg.text, speaker: seg.speaker ?? '', startTime: seg.startTime }).catch((err) =>
        logger.error({ err, meetingInstanceId }, 'handleBargeIn error'),
      )
      handlePartialSegment(s, { text: seg.text, speaker: seg.speaker ?? '' }).catch((err) =>
        logger.error({ err, meetingInstanceId }, 'handlePartialSegment error'),
      )
      // 有人正在出聲 → 重置破冰計時（定稿要慢 1.5–3 秒才到，等它會講到人家身上）
      noteHumanSpeaking(meetingInstanceId)
    },
    onChat: (msg) => {
      const s = activeSessions.get(meetingInstanceId)
      if (!s || !s.botSession) return
      handleChatMessage(s, msg).catch((err) => logger.error({ err, meetingInstanceId }, 'handleChatMessage error'))
      recordConversation(s, {
        speaker: msg.sender,
        text: msg.text,
        source: 'chat',
        fromBot: msg.isFromBot,
        at: msg.timestamp || Date.now(),
      })
      // 聊天訊息記進 chatLog，會後併入逐字稿（蜜塔自己的回覆在 sendChatBestEffort 記錄）
      if (!msg.isFromBot) {
        s.chatLog.push({ speaker: msg.sender, text: msg.text, at: msg.timestamp || Date.now() })
      }
    },
    onStatus: (ev) => {
      // admitted 由 join resolve 處理；此處只處理會議結束（非 mid-meeting failover）。
      if (ev.type === 'ended') {
        handleSessionClose(meetingInstanceId, ev.reason).catch((err) =>
          logger.error({ err, meetingInstanceId }, 'onStatus ended → handleSessionClose error'),
        )
      }
    },
  }
}

// ── closeSession ──────────────────────────────────────────────────────────────
//
// 取消用：從 Map 移除（先移除以阻止任何重連 / admitted 後遺留）並讓 bot 離開。
// 不更新 DB、不觸發摘要。

export async function closeSession(meetingInstanceId: string): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  if (!session) return

  activeSessions.delete(meetingInstanceId)
  clearInterjection(meetingInstanceId)

  if (session.botSession) {
    await botProvider
      .leave(session.botSession)
      .catch((err) => logger.warn({ err, meetingInstanceId }, 'closeSession: leave failed'))
  }
}

// ── handleSessionClose ────────────────────────────────────────────────────────
//
// 會議結束（自然結束 / 使用者讓 bot 離開）：原子鎖更新 DB、讓 bot 離開、觸發摘要。

export async function handleSessionClose(
  meetingInstanceId: string,
  reason?: 'completed' | 'failed',
): Promise<void> {
  const session = activeSessions.get(meetingInstanceId)
  if (!session) {
    // in-memory session 不在（多半是後端重啟後遺失，restore 又接不回 Recall 會議）：
    // DB 仍要收尾，否則會議永久卡 ACTIVE——前端按「結束」顯示成功但狀態不變、摘要無限輪詢。
    // 沒有 session 就沒有 chatLog / provider 識別碼可取逐字稿 → summary 直接落 ''（前端停止輪詢）。
    //
    // where 兩個條件都是必要的，少一個就會吃掉摘要：
    //   status: 'ACTIVE' —— 擋掉正常結束路徑的雙重觸發（Map 已刪、DB 已轉 ENDED）。
    //   summary: null    —— 擋掉一個更窄的競態：正常路徑的順序是
    //     Map.delete → await prisma.update 轉 ENDED → 背景 generateSummaryAsync。
    //     第二次觸發若落在 Map.delete 之後、update 完成之前，DB 還是 ACTIVE，
    //     上面那個條件會通過，於是把 summary 寫成 '' 這個哨兵；真摘要稍後才寫回，
    //     但前端看到哨兵已經停止輪詢，使用者要重整才看得到（WS close 與使用者按
    //     「結束會議」同時發生就會踩到——雙重觸發正是這個原子鎖存在的理由）。
    const finalized = await prisma.meetingInstance.updateMany({
      where: { id: meetingInstanceId, status: 'ACTIVE', summary: null },
      data: {
        status: reason === 'failed' ? 'FAILED' : 'ENDED',
        endedAt: new Date(),
        summary: '',
      },
    })
    if (finalized.count > 0) {
      logger.warn(
        { meetingInstanceId },
        'handleSessionClose: no in-memory session (lost on restart?), finalized dangling ACTIVE meeting',
      )
    }
    return
  }

  // 原子鎖：先從 Map 移除，防止雙重觸發。
  activeSessions.delete(meetingInstanceId)
  clearInterjection(meetingInstanceId)

  const meetbotFinalStatus = reason === 'failed' ? 'FAILED' : 'ENDED'

  await prisma.meetingInstance.update({
    where: { id: meetingInstanceId },
    data: { status: meetbotFinalStatus, endedAt: new Date() },
  })

  // 摘要：用仍在記憶體的 botSession 取逐字稿（provider-agnostic）。
  if (meetbotFinalStatus === 'ENDED') {
    // trackSummary：登記在途，讓 SIGTERM 時等得到（見 summary.service.ts 檔頭）。
    // 仍是 fire-and-forget——這裡不 await，否則 leave 會被摘要拖住 11–35 秒。
    trackSummary(generateSummaryAsync({
      meetingInstanceId,
      platform: session.platform,
      nativeMeetingId: session.nativeMeetingId,
      difyDatasetId: session.difyDatasetId,
      session: session.botSession ?? undefined,
      chatLog: session.chatLog,
      sessionStartedAt: session.sessionStartedAt,
    }))
  }

  if (session.botSession) {
    await botProvider
      .leave(session.botSession)
      .catch((err) => logger.warn({ err, meetingInstanceId }, 'handleSessionClose: leave failed'))
  }
}

// ── restoreActiveSessions ─────────────────────────────────────────────────────
//
// 重啟後清理狀態：Recall 的 bot session 活在記憶體（WS/webhook 連線 + 逐字稿緩衝），
// 進程一死就回不來，也沒有可以重抓的 REST 端點——所以 ACTIVE 會議一律收尾成 ENDED。
//
// 為什麼不再嘗試補摘要（移除 Vexa 前的舊行為）：摘要的輸入是逐字稿，而逐字稿只存在於
// 那個已經消失的 session 裡，重試只會拿到空陣列、生出空摘要。與其假裝努力過，
// 不如直接落 summary='' 這個哨兵讓前端停止輪詢。
// 要真正救回重啟後的摘要，得先讓 segment 落 DB（見 docs/13-系統現況與路線圖.md）。

export async function restoreActiveSessions(): Promise<void> {
  // 階段一：清理 zombie PENDING（超過 5 分鐘仍 PENDING 者標為 FAILED）
  const PENDING_STALE_MINUTES = 5
  const staleThreshold = new Date(Date.now() - PENDING_STALE_MINUTES * 60 * 1000)

  const staleResult = await prisma.meetingInstance.updateMany({
    where: { status: 'PENDING', createdAt: { lt: staleThreshold } },
    data: { status: 'FAILED', endedAt: new Date() },
  })
  if (staleResult.count > 0) {
    logger.warn({ count: staleResult.count }, 'startup: cleaned up zombie PENDING meetings')
  }

  // 階段二：ACTIVE 會議重啟後無法重接 → 收尾成 ENDED + summary=''
  //
  // where 帶 summary: null 是刻意的，與 handleSessionClose 裡的守衛同一個理由：
  // 只在「還沒有摘要」時才寫哨兵，避免把一份已經生好的真摘要蓋成空字串。
  // 這裡的競態雖窄（ACTIVE 期間本來就不該有摘要），但寫上去不花成本，
  // 而漏掉的代價是使用者的摘要無聲消失。
  const activeResult = await prisma.meetingInstance.updateMany({
    where: { status: 'ACTIVE', summary: null },
    data: { status: 'ENDED', endedAt: new Date(), summary: '' },
  })
  // 已有摘要的 ACTIVE（理論上不存在，但別讓它卡在 ACTIVE 永遠不動）：只改狀態，不碰摘要。
  const activeWithSummary = await prisma.meetingInstance.updateMany({
    where: { status: 'ACTIVE', NOT: { summary: null } },
    data: { status: 'ENDED', endedAt: new Date() },
  })
  if (activeResult.count + activeWithSummary.count > 0) {
    logger.warn(
      { count: activeResult.count + activeWithSummary.count, keptSummary: activeWithSummary.count },
      'startup: finalized ACTIVE meetings as ENDED (bot sessions lost on restart)',
    )
  }

  // 階段三：修復 ENDED + summary=null 懸掛。
  // 同上：逐字稿已隨 session 消失，補不回摘要，只能落哨兵讓前端停止輪詢。
  // 門檻 10 分鐘是為了不要誤傷「剛結束、摘要正在背景生成中」的會議。
  const SUMMARY_STALE_MINUTES = 10
  const summaryStaleThreshold = new Date(Date.now() - SUMMARY_STALE_MINUTES * 60 * 1000)

  const staleSummaryResult = await prisma.meetingInstance.updateMany({
    where: { status: 'ENDED', summary: null, endedAt: { lt: summaryStaleThreshold } },
    data: { summary: '' },
  })
  if (staleSummaryResult.count > 0) {
    logger.warn(
      { count: staleSummaryResult.count },
      'startup: reset dangling ENDED+null summary to sentinel',
    )
  }

  logger.info(
    {
      stalePending: staleResult.count,
      activeFinalized: activeResult.count + activeWithSummary.count,
      staleSummary: staleSummaryResult.count,
    },
    'startup restore completed',
  )
}
