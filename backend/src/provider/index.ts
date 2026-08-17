import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'
import { RecallAdapter } from './recall-adapter.js'
import type { MeetingBotProvider } from './types.js'

const recall = new RecallAdapter(env.RECALL_ADMISSION_TIMEOUT_MS)

logger.info({ provider: recall.name }, 'botProvider: initialized')

/**
 * 目前生效的 provider。正常情況恆為 {@link recall}；
 * 只有離線會議模擬器（scripts/simulate-meeting.ts）會換掉它。
 */
let active: MeetingBotProvider = recall

/**
 * 【僅供離線模擬】換掉 bot provider，傳 null 還原成真的 provider。
 */
export function setBotProviderForSimulation(p: MeetingBotProvider | null): void {
  active = p ?? recall
  logger.warn({ provider: active.name }, 'botProvider: overridden for simulation')
}

/**
 * 上層唯一該 import 的 bot provider。
 * 以 Proxy 轉送到 {@link active}，讓模擬器能在 import 之後才抽換。
 */
export const botProvider: MeetingBotProvider = new Proxy({} as MeetingBotProvider, {
  get(_target, prop) {
    const value = (active as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? value.bind(active) : value
  },
})

export * from './types.js'
