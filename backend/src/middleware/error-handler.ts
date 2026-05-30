import type { Context } from 'hono'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message?: string,
    public readonly details?: object,
  ) {
    super(message ?? code)
  }
}

export const errorHandler = (err: Error, c: Context): Response => {
  if (err instanceof AppError) {
    return c.json(
      {
        error_code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      err.statusCode as Parameters<typeof c.json>[1],
    )
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error_code: 'INVALID_REQUEST',
        message: '請求格式錯誤',
        details: err.flatten().fieldErrors,
      },
      400,
    )
  }

  console.error(err)
  return c.json({ error_code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }, 500)
}
