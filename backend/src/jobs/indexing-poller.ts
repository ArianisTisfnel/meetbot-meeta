import { prisma } from '../lib/prisma.js'
import { getIndexingStatus, getDocumentSegments } from '../lib/dify.js'
import { completeText } from '../lib/llm.js'
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

// ── 內容摘要卡 ────────────────────────────────────────────────────────────────
//
// 索引完成的文件由這裡補產摘要卡（50~120 字主題摘要），存回 material.contentCard，
// 供意圖分類器判斷問題是否落在知識庫範圍。掃「COMPLETED 且 contentCard 為 null」
// 而非掛在狀態轉換點上：舊文件自動回填、LLM 暫時掛掉下輪重試，一條路徑涵蓋所有情況。
// sentinel 比照 summary 慣例：null = 尚未產卡（會重試）；'' = 已嘗試但無內容（不再重試）。

/** 每輪最多產卡份數（一份 = 一次 segments API + 一次 LLM 呼叫）。 */
const CARD_BATCH_LIMIT = 3
/** 丟給 LLM 的節錄長度上限（字元）。 */
const CARD_EXCERPT_MAX_CHARS = 3000

async function buildContentCard(
  datasetId: string,
  documentId: string,
  displayName: string,
): Promise<string | null> {
  const segments = await getDocumentSegments(datasetId, documentId, 5)
  const excerpt = segments.join('\n').slice(0, CARD_EXCERPT_MAX_CHARS)
  if (!excerpt.trim()) return null

  const card = await completeText({
    system: [
      '你是文件索引助理。根據文件開頭的節錄，用 50~120 字寫出這份文件「包含哪些主題與資訊類型」',
      '（例如：報名時程、費用、名額、退費規則、銷售數據），供問答系統判斷問題能否由此文件回答。',
      '只輸出摘要本身，不要開場白、不要條列符號。',
    ].join('\n'),
    prompt: `文件《${displayName}》開頭節錄：\n\n${excerpt}`,
    maxTokens: 300,
  })
  return card.trim() || null
}

export async function generateMissingCards(): Promise<void> {
  const missing = await prisma.material.findMany({
    where: {
      indexingStatus: 'COMPLETED',
      contentCard: null,
      difyDocumentId: { not: null },
      deletedAt: null,
    },
    include: { project: { select: { difyDatasetId: true } } },
    orderBy: { uploadedAt: 'asc' },
    take: CARD_BATCH_LIMIT,
  })

  for (const material of missing) {
    try {
      const card = await buildContentCard(
        material.project.difyDatasetId,
        material.difyDocumentId!,
        material.displayName,
      )
      // card 為 null（文件抽不出文字/LLM 回空）→ 存 ''：已嘗試無內容，不再重試
      await prisma.material.update({
        where: { id: material.id },
        data: { contentCard: card ?? '' },
      })
      logger.info(
        { materialId: material.id, hasCard: Boolean(card) },
        'Content card generated',
      )
    } catch (err) {
      // 保持 null → 下一輪重試（Dify/LLM 暫時性錯誤）
      logger.warn({ err, materialId: material.id }, 'Content card generation failed, will retry')
    }
  }
}

export function startIndexingPoller(): void {
  setInterval(() => {
    pollOnce().catch((err: unknown) =>
      logger.error({ err }, 'Indexing poller: unexpected error in poll cycle'),
    )
  }, 30_000)

  setInterval(() => {
    generateMissingCards().catch((err: unknown) =>
      logger.error({ err }, 'Content card job: unexpected error in cycle'),
    )
  }, 60_000)

  logger.info('Indexing poller started (status: 30s, content cards: 60s)')
}

export { pollOnce }
