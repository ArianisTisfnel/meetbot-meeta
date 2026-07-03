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

/**
 * 上層唯一該 import 的 bot provider。
 * 永遠是 FailoverProvider；secondary 為 null 時退化為單一 provider、不 failover。
 */
export const botProvider: MeetingBotProvider = new FailoverProvider(primary, secondary)

export * from './types.js'
