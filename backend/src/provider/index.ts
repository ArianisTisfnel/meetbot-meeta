import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { VexaAdapter } from './vexa-adapter.js'
import { RecallAdapter } from './recall-adapter.js'
import { FailoverProvider } from './failover-provider.js'
import type { MeetingBotProvider } from './types.js'

const vexa = new VexaAdapter(env.BOT_ADMISSION_TIMEOUT_MS)

// Recall 為 optional：兩個必要設定都齊全才啟用 failover，否則只用 Vexa。
// Recall 用較長的 admission 逾時（Recall bot 進場本身就慢）。
const recallEnabled = Boolean(env.RECALL_API_URL && env.RECALL_API_KEY)
const recall = recallEnabled ? new RecallAdapter(env.RECALL_ADMISSION_TIMEOUT_MS) : null

if (recallEnabled) {
  logger.info('botProvider: Vexa (primary) + Recall (failover) enabled')
} else {
  logger.info('botProvider: Vexa only (Recall failover not configured)')
}

/**
 * 上層唯一該 import 的 bot provider。
 * 永遠是 FailoverProvider；未設定 Recall 時退化為「只用 Vexa、不 failover」。
 */
export const botProvider: MeetingBotProvider = new FailoverProvider(vexa, recall)

export * from './types.js'
