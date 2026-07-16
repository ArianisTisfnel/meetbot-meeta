import { prisma } from '../lib/prisma.js'
import { logger } from '../middleware/logger.js'
import { uploadDocument, deleteDocument } from '../lib/dify.js'

/**
 * 會議記錄回灌知識庫：把「摘要＋重點主題＋決議＋待辦＋逐字稿」組成一份
 * markdown 文件上傳到專案的 Dify dataset，讓下一場會議可以問
 * 「上次會議決定了什麼」「誰負責 X」。
 *
 * 呼叫點：
 *   1. generateSummaryAsync 摘要落定後（第一輪，Recall 逐字稿版）
 *   2. retranscription-poller finalize 後（v2 高品質版，刪舊傳新替換）
 *
 * 永遠 best-effort：任何失敗只記 log，不得影響摘要/重轉錄主流程。
 * 無專案的會議（projectId=null，無 dataset 可灌）直接跳過。
 */

/** 把 Json 欄位安全轉成字串陣列（格式不符時回空，不丟錯）。 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

/** actionItems 慣用形狀 [{task, owner}]；容錯處理純字串或缺 owner。 */
function formatActionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim())
    } else if (item && typeof item === 'object') {
      const task = (item as any).task
      if (typeof task === 'string' && task.trim()) {
        const owner = (item as any).owner
        out.push(typeof owner === 'string' && owner.trim() ? `${task}（負責人：${owner}）` : task)
      }
    }
  }
  return out
}

export function buildMeetingRecordMarkdown(meeting: {
  name: string
  endedAt: Date | null
  summary: string | null
  keyTopics: unknown
  decisions: unknown
  actionItems: unknown
}, transcriptMd: string): string {
  const lines: string[] = [`# 會議記錄：${meeting.name}`]
  if (meeting.endedAt) {
    lines.push(`會議結束時間：${meeting.endedAt.toISOString().slice(0, 16).replace('T', ' ')}（UTC）`)
  }

  if (meeting.summary?.trim()) {
    lines.push('', '## 摘要', meeting.summary.trim())
  }
  const keyTopics = asStringArray(meeting.keyTopics)
  if (keyTopics.length) {
    lines.push('', '## 重點主題', ...keyTopics.map((t) => `- ${t}`))
  }
  const decisions = asStringArray(meeting.decisions)
  if (decisions.length) {
    lines.push('', '## 決議', ...decisions.map((d) => `- ${d}`))
  }
  const actionItems = formatActionItems(meeting.actionItems)
  if (actionItems.length) {
    lines.push('', '## 待辦事項', ...actionItems.map((a) => `- ${a}`))
  }
  lines.push('', '## 逐字稿', transcriptMd)
  return lines.join('\n')
}

/**
 * 上傳（或替換）會議記錄文件到專案知識庫。內部吞掉所有錯誤（只記 log）。
 * 讀 DB 現值組文件——兩個呼叫點都在 summary/actionItems 寫入 DB 之後。
 */
export async function syncMeetingRecordToKb(
  meetingInstanceId: string,
  transcriptMd: string,
): Promise<void> {
  try {
    if (!transcriptMd.trim()) return

    const meeting = await prisma.meetingInstance.findUnique({
      where: { id: meetingInstanceId },
      select: {
        name: true,
        endedAt: true,
        summary: true,
        keyTopics: true,
        decisions: true,
        actionItems: true,
        kbDocumentId: true,
        project: { select: { difyDatasetId: true } },
      },
    })
    if (!meeting) return
    const datasetId = meeting.project?.difyDatasetId
    if (!datasetId) {
      logger.debug({ meetingInstanceId }, 'Meeting KB sync: no project dataset, skipping')
      return
    }

    const markdown = buildMeetingRecordMarkdown(meeting, transcriptMd)

    // 替換語意：v2 重轉錄（或摘要重跑）時刪掉上一版文件，避免 KB 同場會議雙份。
    // 刪除失敗（如已被手動刪）不阻擋上傳新版。
    if (meeting.kbDocumentId) {
      await deleteDocument(datasetId, meeting.kbDocumentId).catch((err) =>
        logger.warn(
          { err, meetingInstanceId, kbDocumentId: meeting.kbDocumentId },
          'Meeting KB sync: failed to delete previous document, uploading new anyway',
        ),
      )
    }

    const dateTag = (meeting.endedAt ?? new Date()).toISOString().slice(0, 10)
    const { documentId } = await uploadDocument(datasetId, {
      buffer: Buffer.from(markdown, 'utf-8'),
      filename: `會議記錄-${meeting.name}-${dateTag}.md`,
      mimeType: 'text/markdown',
    })

    await prisma.meetingInstance.update({
      where: { id: meetingInstanceId },
      data: { kbDocumentId: documentId },
    })
    logger.info(
      { meetingInstanceId, kbDocumentId: documentId, replaced: Boolean(meeting.kbDocumentId) },
      'Meeting KB sync: meeting record uploaded to project knowledge base',
    )
  } catch (err) {
    logger.warn({ err, meetingInstanceId }, 'Meeting KB sync failed (best-effort, skipped)')
  }
}
