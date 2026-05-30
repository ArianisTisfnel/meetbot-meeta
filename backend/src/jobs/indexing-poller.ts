import { prisma } from '../lib/prisma.js'
import { getIndexingStatus } from '../lib/dify.js'
import { logger } from '../middleware/logger.js'

async function pollOnce(): Promise<void> {
  const processing = await prisma.material.findMany({
    where: { indexingStatus: { in: ['PENDING', 'PROCESSING'] }, deletedAt: null },
    include: { project: { select: { difyDatasetId: true } } },
  })

  for (const material of processing) {
    if (material.difyBatch) {
      try {
        const result = await getIndexingStatus(material.project.difyDatasetId, material.difyBatch)
        await prisma.material.update({
          where: { id: material.id },
          data: {
            indexingStatus: result.status,
            indexingError: result.error ?? null,
          },
        })
      } catch (err) {
        logger.error({ err, materialId: material.id }, 'Indexing poller: failed to update status')
      }
    }
  }
}

export function startIndexingPoller(): void {
  setInterval(() => {
    pollOnce().catch((err: unknown) =>
      logger.error({ err }, 'Indexing poller: unexpected error in poll cycle'),
    )
  }, 30_000)

  logger.info('Indexing poller started (interval: 30s)')
}

export { pollOnce }
