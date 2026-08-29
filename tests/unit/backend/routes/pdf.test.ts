import { describe, it, expect } from 'vitest'
// 用與 pdf.ts 相同的 '.js' 指定式，否則 vite 會把 error-handler 解析成第二份模組，
// errorHandler 裡的 `err instanceof AppError` 會對不上而全部落到 500。
import { errorHandler } from '../../../../backend/src/middleware/error-handler.js'
import app from '../../../../backend/src/routes/pdf.js'

// AppError／ZodError 的狀態碼由全域 onError 翻譯（index.ts 掛在根 app 上）。
// authMiddleware 不在這裡驗——那是 index.ts 的 '*' 中介層，另有 auth.test.ts 覆蓋。
app.onError(errorHandler)

const post = (body: unknown) =>
  app.request('/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /pdf — 純文字轉繁中 PDF', () => {
  it('正常請求 → 200 application/pdf，且真的是 PDF', async () => {
    const res = await post({
      title: '會議報告 2026-08-29',
      text: '【摘要】\n測試中文段落。\n\n第二段。',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('text 超過 500k 字 → 413（不是 400，逐字稿爆量要看得出來）', async () => {
    const res = await post({ title: 't', text: 'a'.repeat(500_001) })
    expect(res.status).toBe(413)
    expect((await res.json()).error_code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('缺 title → 400', async () => {
    expect((await post({ text: 'hi' })).status).toBe(400)
  })

  it('title 過長 → 400', async () => {
    expect((await post({ title: 'x'.repeat(201), text: 'hi' })).status).toBe(400)
  })
})
