import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { env } from '../types/env.js'
import { AppError } from '../middleware/error-handler.js'

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true, // MinIO 只支援 path-style，不支援 virtual-hosted-style
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
})

export async function uploadFile(path: string, buffer: Buffer, mimeType: string): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: path, Body: buffer, ContentType: mimeType }),
    )
  } catch (err) {
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Storage upload error: ${String(err)}`)
  }
}

// S3 PutObject 本來就是 upsert 語意，跟 uploadFile 完全相同。
export async function upsertFile(path: string, buffer: Buffer, mimeType: string): Promise<void> {
  return uploadFile(path, buffer, mimeType)
}

/** 下載 Storage 檔案為文字；404（檔案不存在）回傳 null，其餘錯誤丟出。 */
export async function downloadTextFile(path: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: path }))
    return (await res.Body?.transformToString('utf-8')) ?? null
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Storage download error: ${String(err)}`)
  }
}

export async function deleteFile(path: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: path }))
  } catch (err) {
    throw new AppError('EXTERNAL_SERVICE_ERROR', 503, `Storage delete error: ${String(err)}`)
  }
}
