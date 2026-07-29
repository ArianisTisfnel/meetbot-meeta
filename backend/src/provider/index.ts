import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { VexaAdapter } from './vexa-adapter.js'
import { RecallAdapter } from './recall-adapter.js'
import { FailoverProvider } from './failover-provider.js'
import type { MeetingBotProvider } from './types.js'

const vexa = new VexaAdapter(env.BOT_ADMISSION_TIMEOUT_MS)

// Recall 需兩個必要設定齊全才可用。
const recallEnabled = Boolean(env.RECALL_API_URL && env.RECALL_API_KEY)
const recall = recallEnabled ? new RecallAdapter(env.RECALL_ADMISSION_TIMEOUT_MS) : null

// 主/備由 BOT_PRIMARY_PROVIDER 決定（預設 recall：Vexa 進場被 reCAPTCHA 擋死後的決策）。
// 選 recall 但未設定 Recall 時，警告並退回 Vexa-only，避免完全不能派 bot。
const recallPrimary = env.BOT_PRIMARY_PROVIDER === 'recall' && recallEnabled

if (env.BOT_PRIMARY_PROVIDER === 'recall' && !recallEnabled) {
  logger.warn('botProvider: BOT_PRIMARY_PROVIDER=recall 但 RECALL_API_URL/KEY 未設定，退回 Vexa only')
}

const primary: MeetingBotProvider = recallPrimary ? recall! : vexa
const secondary: MeetingBotProvider | null = recallPrimary ? vexa : recall

logger.info(
  { primary: primary.name, secondary: secondary?.name ?? null },
  'botProvider: failover chain configured',
)

const realProvider: MeetingBotProvider = new FailoverProvider(primary, secondary)

/**
 * 目前生效的 provider。正常情況恆為 {@link realProvider}；
 * 只有離線會議模擬器（scripts/simulate-meeting.ts）會換掉它。
 */
let active: MeetingBotProvider = realProvider

/**
 * 【僅供離線模擬】換掉 bot provider，傳 null 還原成真的 provider。
 *
 * 為什麼需要這個接縫：session/喚醒/插話全鏈路都直接 import `botProvider`，
 * 沒有注入點就只能開真會議才驗得到蜜塔的行為（回報 2026-07-28 C）。
 * **正式流程永不呼叫**——預設值是真 provider，不設定就沒有任何行為差異。
 */
export function setBotProviderForSimulation(p: MeetingBotProvider | null): void {
  active = p ?? realProvider
  logger.warn({ provider: active.name }, 'botProvider: overridden for simulation')
}

/**
 * 上層唯一該 import 的 bot provider。
 * 永遠是 FailoverProvider；secondary 為 null 時退化為單一 provider、不 failover。
 *
 * 以 Proxy 轉送到 {@link active}，讓模擬器能在 import 之後才抽換。
 * 方法一律 bind 到 active——adapter 內部用 this，不 bind 會拿到 Proxy 當 this。
 */
export const botProvider: MeetingBotProvider = new Proxy({} as MeetingBotProvider, {
  get(_target, prop) {
    const value = (active as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? value.bind(active) : value
  },
})

export * from './types.js'
