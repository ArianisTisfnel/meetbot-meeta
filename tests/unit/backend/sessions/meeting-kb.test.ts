import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mockPrisma } from '../../../mocks/prisma.mock'

vi.mock('../../../../backend/src/lib/prisma', () => ({ prisma: mockPrisma }))

const mockUploadDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ documentId: 'kb-doc-1', batch: 'batch-1' }),
)
const mockDeleteDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../../../backend/src/lib/dify', () => ({
  uploadDocument: mockUploadDocument,
  deleteDocument: mockDeleteDocument,
}))

import {
  syncMeetingRecordToKb,
  buildMeetingRecordMarkdown,
} from '../../../../backend/src/sessions/meeting-kb'

const baseMeeting = {
  name: 'Q3 規劃會議',
  endedAt: new Date('2026-07-16T03:00:00Z'),
  summary: '討論了 Q3 目標與分工。',
  keyTopics: ['Q3 目標', '人力分配'],
  decisions: ['採用方案 B'],
  actionItems: [{ task: '整理報名系統需求', owner: 'Alice' }, { task: '約下次會議' }],
  kbDocumentId: null,
  project: { difyDatasetId: 'dataset-abc' },
}

describe('buildMeetingRecordMarkdown', () => {
  it('組出含摘要/主題/決議/待辦/逐字稿的完整文件', () => {
    const md = buildMeetingRecordMarkdown(baseMeeting, '[0:05] Alice: 開始開會')

    expect(md).toContain('# 會議記錄：Q3 規劃會議')
    expect(md).toContain('## 摘要\n討論了 Q3 目標與分工。')
    expect(md).toContain('- Q3 目標')
    expect(md).toContain('- 採用方案 B')
    expect(md).toContain('- 整理報名系統需求（負責人：Alice）')
    expect(md).toContain('- 約下次會議') // 缺 owner 時不加負責人註記
    expect(md).toContain('## 逐字稿\n[0:05] Alice: 開始開會')
  })

  it('summary 為空、Json 欄位格式不符 → 略過對應區塊、不丟錯', () => {
    const md = buildMeetingRecordMarkdown(
      { ...baseMeeting, summary: '', keyTopics: 'not-array', decisions: null, actionItems: 42 },
      '逐字稿內容',
    )

    expect(md).not.toContain('## 摘要')
    expect(md).not.toContain('## 重點主題')
    expect(md).not.toContain('## 決議')
    expect(md).not.toContain('## 待辦事項')
    expect(md).toContain('## 逐字稿')
  })
})

describe('syncMeetingRecordToKb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.meetingInstance.update.mockResolvedValue({})
  })

  it('首次上傳：uploadDocument 到專案 dataset、kbDocumentId 存回 DB', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValueOnce({ ...baseMeeting })

    await syncMeetingRecordToKb('meet-1', '[0:05] Alice: 哈囉')

    expect(mockDeleteDocument).not.toHaveBeenCalled()
    expect(mockUploadDocument).toHaveBeenCalledWith(
      'dataset-abc',
      expect.objectContaining({
        filename: '會議記錄-Q3 規劃會議-2026-07-16.md',
        mimeType: 'text/markdown',
      }),
    )
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith({
      where: { id: 'meet-1' },
      data: { kbDocumentId: 'kb-doc-1' },
    })
  })

  it('已有 kbDocumentId（v2 替換）→ 先刪舊文件再傳新', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValueOnce({
      ...baseMeeting,
      kbDocumentId: 'kb-doc-old',
    })

    await syncMeetingRecordToKb('meet-1', 'v2 逐字稿')

    expect(mockDeleteDocument).toHaveBeenCalledWith('dataset-abc', 'kb-doc-old')
    expect(mockUploadDocument).toHaveBeenCalled()
    // 刪除先於上傳
    expect(mockDeleteDocument.mock.invocationCallOrder[0]).toBeLessThan(
      mockUploadDocument.mock.invocationCallOrder[0],
    )
  })

  it('刪舊文件失敗 → 照樣上傳新版（不阻擋）', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValueOnce({
      ...baseMeeting,
      kbDocumentId: 'kb-doc-old',
    })
    mockDeleteDocument.mockRejectedValueOnce(new Error('already deleted'))

    await syncMeetingRecordToKb('meet-1', 'v2 逐字稿')

    expect(mockUploadDocument).toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kbDocumentId: 'kb-doc-1' } }),
    )
  })

  it('無專案（project=null）→ 跳過，不上傳', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValueOnce({
      ...baseMeeting,
      project: null,
    })

    await syncMeetingRecordToKb('meet-1', '逐字稿')

    expect(mockUploadDocument).not.toHaveBeenCalled()
    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalled()
  })

  it('逐字稿為空白 → 跳過（連 DB 都不查）', async () => {
    await syncMeetingRecordToKb('meet-1', '   ')

    expect(mockPrisma.meetingInstance.findUnique).not.toHaveBeenCalled()
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('上傳失敗 → 吞錯不 throw（best-effort），kbDocumentId 不更新', async () => {
    mockPrisma.meetingInstance.findUnique.mockResolvedValueOnce({ ...baseMeeting })
    mockUploadDocument.mockRejectedValueOnce(new Error('Dify 503'))

    await expect(syncMeetingRecordToKb('meet-1', '逐字稿')).resolves.toBeUndefined()

    expect(mockPrisma.meetingInstance.update).not.toHaveBeenCalled()
  })
})
