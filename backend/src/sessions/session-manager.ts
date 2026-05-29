import { logger } from '../middleware/logger.js'

// TODO: P5 — restore ACTIVE meeting sessions from DB after service restart
export async function restoreActiveSessions(): Promise<void> {
  logger.info('Session restore stub — will be implemented in P5')
}
