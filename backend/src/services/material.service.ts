import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { uploadFile, deleteFile } from '../lib/supabase.js'
import { uploadDocument, deleteDocument } from '../lib/dify.js'
import { AppError } from '../middleware/error-handler.js'
import { logger } from '../middleware/logger.js'
import { recordActivity } from './activity.service.js'

const MAX_SIZE_BYTES = 15 * 1024 * 1024 // 15 MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
])

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function requireEditAccess(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { vexaUserId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')

  const isOwner = project.ownerVexaUserId === vexaUserId
  if (isOwner) return project

  const m = project.members[0]
  if (!m || !m.canEdit) {
    throw new AppError('PERMISSION_DENIED', 403, '您沒有編輯此專案的權限')
  }
  return project
}

async function requireViewAccess(projectId: string, vexaUserId: number) {
  const project = await prisma.project.findUnique({
    where: { id: projectId, deletedAt: null },
    include: { members: { where: { vexaUserId } } },
  })
  if (!project) throw new AppError('NOT_FOUND', 404, '專案不存在')

  const isOwner = project.ownerVexaUserId === vexaUserId
  if (isOwner) return project

  const m = project.members[0]
  if (!m || (!m.canView && !m.canEdit && !m.canMeeting)) {
    throw new AppError('PERMISSION_DENIED', 403, '您沒有存取此專案的權限')
  }
  return project
}

export async function uploadMaterial(
  projectId: string,
  vexaUserId: number,
  file: {
    buffer: Buffer
    filename: string
    mimeType: string
    displayName?: string
  },
) {
  // ① Validate MIME type and size
  if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, '僅支援 PDF、DOCX、TXT、MD')
  }
  if (file.buffer.length > MAX_SIZE_BYTES) {
    throw new AppError('FILE_TOO_LARGE', 413, '檔案大小超過 15 MB 限制')
  }

  const project = await requireEditAccess(projectId, vexaUserId)

  // ② SHA-256 deduplication
  const hash = sha256(file.buffer)

  const existing = await prisma.material.findFirst({
    where: { projectId, sha256: hash },
  })

  if (existing && !existing.deletedAt) {
    throw new AppError('DUPLICATE_FILE', 409, '相同檔案已上傳至此專案', {
      existingMaterialId: existing.id,
    })
  }

  if (existing && existing.deletedAt) {
    // Free up the unique slot so we can insert a new record
    await prisma.material.update({
      where: { id: existing.id },
      data: { sha256: `DELETED_${existing.id}` },
    })
  }

  // ③ Upload to Supabase Storage: {projectId}/{uuid}/{safeName}
  // Supabase Storage 物件 key 僅接受 ASCII 安全字元，非 ASCII（如中文檔名）會被拒（InvalidKey）。
  // 原始檔名仍存於 DB（filename / displayName），這裡只用清理過的安全名稱當儲存 key。
  const safeName =
    file.filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_') || 'file'
  const fileUuid = crypto.randomUUID()
  const storagePath = `${projectId}/${fileUuid}/${safeName}`
  await uploadFile(storagePath, file.buffer, file.mimeType)

  let documentId: string | undefined
  let batch: string | undefined

  try {
    // ④ Upload to Dify (use project's difyDatasetId, not projectId)
    const difyResult = await uploadDocument(project.difyDatasetId, {
      buffer: file.buffer,
      filename: file.filename,
      mimeType: file.mimeType,
    })
    documentId = difyResult.documentId
    batch = difyResult.batch
  } catch (err) {
    // ④ failed → rollback Storage
    await deleteFile(storagePath).catch((e: unknown) =>
      logger.error({ err: e }, 'Rollback: failed to delete storage file'),
    )
    throw err
  }

  let material: Awaited<ReturnType<typeof prisma.material.create>>

  try {
    // ⑤ Prisma create Material
    material = await prisma.material.create({
      data: {
        projectId,
        filename: file.filename,
        displayName: file.displayName ?? file.filename,
        sizeBytes: BigInt(file.buffer.length),
        mimeType: file.mimeType,
        sha256: hash,
        storagePath,
        difyDocumentId: documentId,
        difyBatch: batch,
        uploadedByVexaUserId: vexaUserId,
      },
    })
  } catch (err) {
    // ⑤ failed → rollback Storage + Dify
    await deleteFile(storagePath).catch((e: unknown) =>
      logger.error({ err: e }, 'Rollback: failed to delete storage file'),
    )
    if (documentId) {
      await deleteDocument(project.difyDatasetId, documentId).catch((e: unknown) =>
        logger.error({ err: e }, 'Rollback: failed to delete Dify document'),
      )
    }

    if ((err as { code?: string })?.code === 'P2002') {
      throw new AppError('DUPLICATE_FILE', 409, '相同檔案已上傳至此專案')
    }
    throw err
  }

  // ⑥ MaterialEditHistory (best-effort, no rollback on failure)
  await prisma.materialEditHistory
    .create({
      data: {
        projectId,
        materialId: material.id,
        action: 'UPLOAD',
        filenameSnapshot: file.filename,
        performedByVexaUserId: vexaUserId,
      },
    })
    .catch((e: unknown) => logger.error({ err: e }, 'Failed to write MaterialEditHistory for UPLOAD'))

  await recordActivity({
    projectId,
    actorVexaUserId: vexaUserId,
    action: 'MATERIAL_UPLOAD',
    targetLabel: file.filename,
  })

  const uploaderRows = await prisma.$queryRaw<Array<{ id: number; name: string | null }>>`
    SELECT id, name FROM public.users WHERE id = ${vexaUserId} LIMIT 1
  `

  return {
    id: material.id,
    filename: material.filename,
    displayName: material.displayName,
    sizeBytes: Number(material.sizeBytes),
    mimeType: material.mimeType,
    indexingStatus: material.indexingStatus,
    uploadedBy: {
      vexaUserId,
      name: uploaderRows[0]?.name ?? null,
    },
    uploadedAt: material.uploadedAt,
  }
}

export async function listMaterials(
  projectId: string,
  vexaUserId: number,
  params: { page?: number; perPage?: number; status?: string } = {},
) {
  await requireViewAccess(projectId, vexaUserId)

  const { page = 1, perPage = 20, status } = params

  const where: Prisma.MaterialWhereInput = { projectId, deletedAt: null }
  if (status) {
    where.indexingStatus = status as Prisma.EnumIndexingStatusFilter
  }

  const [materials, total] = await Promise.all([
    prisma.material.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.material.count({ where }),
  ])

  const uploaderIds = [...new Set(materials.map((m) => m.uploadedByVexaUserId))]
  let uploaderMap = new Map<number, { name: string | null }>()
  if (uploaderIds.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ id: number; name: string | null }>>`
      SELECT id, name FROM public.users WHERE id IN (${Prisma.join(uploaderIds)})
    `
    uploaderMap = new Map(rows.map((r) => [r.id, { name: r.name }]))
  }

  return {
    items: materials.map((m) => ({
      id: m.id,
      filename: m.filename,
      displayName: m.displayName,
      sizeBytes: Number(m.sizeBytes),
      mimeType: m.mimeType,
      indexingStatus: m.indexingStatus,
      uploadedBy: {
        vexaUserId: m.uploadedByVexaUserId,
        name: uploaderMap.get(m.uploadedByVexaUserId)?.name ?? null,
      },
      uploadedAt: m.uploadedAt,
    })),
    total,
    page,
    perPage,
  }
}

export async function getMaterial(projectId: string, materialId: string, vexaUserId: number) {
  await requireViewAccess(projectId, vexaUserId)

  const material = await prisma.material.findUnique({
    where: { id: materialId },
  })

  if (!material || material.projectId !== projectId || material.deletedAt) {
    throw new AppError('NOT_FOUND', 404, '檔案不存在')
  }

  const uploaderRows = await prisma.$queryRaw<Array<{ id: number; name: string | null }>>`
    SELECT id, name FROM public.users WHERE id = ${material.uploadedByVexaUserId} LIMIT 1
  `

  return {
    id: material.id,
    filename: material.filename,
    displayName: material.displayName,
    sizeBytes: Number(material.sizeBytes),
    mimeType: material.mimeType,
    indexingStatus: material.indexingStatus,
    indexingError: material.indexingError ?? null,
    uploadedBy: {
      vexaUserId: material.uploadedByVexaUserId,
      name: uploaderRows[0]?.name ?? null,
    },
    uploadedAt: material.uploadedAt,
    updatedAt: material.updatedAt,
  }
}

export async function deleteMaterial(projectId: string, materialId: string, vexaUserId: number) {
  await requireEditAccess(projectId, vexaUserId)

  const material = await prisma.material.findUnique({
    where: { id: materialId },
    include: { project: { select: { difyDatasetId: true } } },
  })

  if (!material || material.projectId !== projectId || material.deletedAt) {
    throw new AppError('NOT_FOUND', 404, '檔案不存在')
  }

  // ① Delete Dify document (best-effort)
  if (material.difyDocumentId) {
    await deleteDocument(material.project.difyDatasetId, material.difyDocumentId).catch(
      (e: unknown) => logger.error({ err: e }, 'deleteMaterial: failed to delete Dify document'),
    )
  }

  // ② Delete Storage file (best-effort)
  await deleteFile(material.storagePath).catch((e: unknown) =>
    logger.error({ err: e }, 'deleteMaterial: failed to delete Storage file'),
  )

  // ③ Soft delete Material
  await prisma.material
    .update({
      where: { id: materialId },
      data: { deletedAt: new Date() },
    })
    .catch((e: unknown) => logger.error({ err: e }, 'deleteMaterial: failed to soft-delete Material'))

  // ④ MaterialEditHistory (best-effort)
  await prisma.materialEditHistory
    .create({
      data: {
        projectId,
        materialId,
        action: 'DELETE',
        filenameSnapshot: material.filename,
        performedByVexaUserId: vexaUserId,
      },
    })
    .catch((e: unknown) =>
      logger.error({ err: e }, 'deleteMaterial: failed to write MaterialEditHistory'),
    )

  await recordActivity({
    projectId,
    actorVexaUserId: vexaUserId,
    action: 'MATERIAL_DELETE',
    targetLabel: material.filename,
  })
}

export async function listHistory(
  projectId: string,
  vexaUserId: number,
  params: { page?: number; perPage?: number } = {},
) {
  await requireViewAccess(projectId, vexaUserId)

  const { page = 1, perPage = 20 } = params

  const where = { projectId }

  const [items, total] = await Promise.all([
    prisma.materialEditHistory.findMany({
      where,
      orderBy: { performedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.materialEditHistory.count({ where }),
  ])

  const performerIds = [...new Set(items.map((i) => i.performedByVexaUserId))]
  let performerMap = new Map<number, { name: string | null }>()
  if (performerIds.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ id: number; name: string | null }>>`
      SELECT id, name FROM public.users WHERE id IN (${Prisma.join(performerIds)})
    `
    performerMap = new Map(rows.map((r) => [r.id, { name: r.name }]))
  }

  return {
    items: items.map((i) => ({
      id: i.id,
      action: i.action,
      filenameSnapshot: i.filenameSnapshot,
      performedBy: {
        vexaUserId: i.performedByVexaUserId,
        name: performerMap.get(i.performedByVexaUserId)?.name ?? null,
      },
      performedAt: i.performedAt,
    })),
    total,
    page,
    perPage,
  }
}
