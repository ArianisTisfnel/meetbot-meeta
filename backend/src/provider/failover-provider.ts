import { logger } from '../middleware/logger.js'
import type {
  BotOptions,
  BotSession,
  LiveHandlers,
  MeetingBotProvider,
  TranscriptSegment,
} from './types.js'

/**
 * FailoverProvider — 上層唯一入口。
 *
 * v1 只做 **join-time failover**：派 bot 進會議，primary（Vexa）若在 timeout 內沒「真正進去」
 * （被擋在門外 / timeout，由 adapter 丟出 BotAdmissionError），就 fallback 到 secondary（Recall）。
 *
 * 成本原則：secondary 只在 primary **確定失敗**時才被呼叫，Vexa 正常時完全不碰 Recall，
 * 也不會平行同時派兩個 bot。
 *
 * join 之後的所有操作（getTranscript/speak/sendChat/leave）一律委派給
 * `session.adapter`（建立該 session 的具體 provider），**完全不比對 provider 名稱**，
 * 因此這裡與上層都沒有 `if (provider === 'vexa')` 之類的分支。
 *
 * 明確不做：mid-meeting failover（轉錄到一半死掉、Recall 中途補位）。
 */
export class FailoverProvider implements MeetingBotProvider {
  readonly name = 'failover'

  constructor(
    private readonly primary: MeetingBotProvider,
    private readonly secondary: MeetingBotProvider | null,
  ) {}

  async join(url: string, opts: BotOptions, handlers: LiveHandlers): Promise<BotSession> {
    try {
      const session = await this.primary.join(url, opts, handlers)
      logger.info(
        { provider: this.primary.name, nativeMeetingId: opts.nativeMeetingId },
        'failover: primary provider admitted',
      )
      return session
    } catch (primaryErr) {
      if (!this.secondary) {
        logger.warn(
          { err: primaryErr, nativeMeetingId: opts.nativeMeetingId },
          'failover: primary failed and no secondary configured',
        )
        throw primaryErr
      }

      logger.warn(
        { err: primaryErr, primary: this.primary.name, secondary: this.secondary.name, nativeMeetingId: opts.nativeMeetingId },
        'failover: primary not admitted, falling back to secondary',
      )

      // primary 確定進不去後，才付費走 secondary。
      const session = await this.secondary.join(url, opts, handlers)
      logger.info(
        { provider: this.secondary.name, nativeMeetingId: opts.nativeMeetingId },
        'failover: secondary provider admitted',
      )
      return session
    }
  }

  getTranscript(session: BotSession): Promise<TranscriptSegment[]> {
    return session.adapter.getTranscript(session)
  }

  speak(session: BotSession, text: string): Promise<void> {
    return session.adapter.speak(session, text)
  }

  async sendChat(session: BotSession, text: string): Promise<void> {
    if (!session.adapter.sendChat) {
      throw new Error(`${session.adapter.name}: sendChat not supported (known limitation)`)
    }
    await session.adapter.sendChat(session, text)
  }

  leave(session: BotSession): Promise<void> {
    return session.adapter.leave(session)
  }
}
