import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import PDFDocument from 'pdfkit'
import { AppError } from '../middleware/error-handler.js'
import type { AppEnv } from '../types/hono.js'

const app = new Hono<AppEnv>()

// 全域 authMiddleware 已掛在 '*' 上，且 /pdf 不在任何跳過清單（/webhooks/、/internal/、
// GET /agent）內 → 這個端點一定要帶 Bearer。這是「任意文字轉檔」，不能匿名。

const MAX_TEXT = 500_000 // 逐字稿可能很長；超過回 413
const MAX_TITLE = 200

const bodySchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  text: z.string(),
})

// mm → pt。版面沿用前端被取代掉的 printTextDocument：A4、上下 18mm／左右 16mm、
// 標題 16pt、日期 10pt 灰字、內文 12pt 行高 1.8。
const mm = (v: number) => (v * 72) / 25.4
const BODY_PT = 12

// 字型 5.4MB，用 import.meta.url 定位（不依賴 cwd，pm2 從任何目錄啟動都對），
// 第一次用到才讀進來並常駐，避免每個請求都重讀磁碟。
// ponytail: Noto Sans TC 只有 BMP 常用中日文＋拉丁＋假名（20,950 字），CJK 擴充 A/B
// （䶮、㸚、𠀋）與韓文缺字會印成空白框。要補得換覆蓋更廣的字型（Noto Sans CJK TC 全量約 16MB）。
const FONT_PATH = fileURLToPath(new URL('../../assets/NotoSansTC-Regular.otf', import.meta.url))
let fontBuf: Buffer | undefined
const font = (): Buffer => (fontBuf ??= readFileSync(FONT_PATH))

app.post(
  '/pdf',
  // 長度上限在 c.req.json() 之後才驗得到，那時整個 body 已經進記憶體了。
  // 單進程後端，先在串流層擋掉離譜的 body（500k 字 UTF-8 約 1.5MB）。
  bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 413, '請求內容過大')
    },
  }),
  async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}))
    const rawText = (raw as { text?: unknown })?.text
    if (typeof rawText === 'string' && rawText.length > MAX_TEXT) {
      throw new AppError('PAYLOAD_TOO_LARGE', 413, `text 長度上限 ${MAX_TEXT} 字`)
    }
    const { title, text } = bodySchema.parse(raw)

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: mm(18), bottom: mm(18), left: mm(16), right: mm(16) },
      info: { Title: title },
    })
    doc.font(font())

    doc.fontSize(16).fillColor('#000').text(title)
    doc.moveDown(0.3)
    doc
      .fontSize(10)
      .fillColor('#666')
      .text(new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }))
    doc.moveDown(1)

    // 行高 1.8：lineGap 是「額外」間距，所以要扣掉字型自然行高。
    doc.fontSize(BODY_PT).fillColor('#000')
    doc.lineGap(Math.max(0, BODY_PT * 1.8 - doc.currentLineHeight()))
    // text 是前端組好的純文字（可能含【摘要】這種標題行），不解析結構，原樣排版。
    doc.text(text)
    doc.end()

    c.header('Content-Type', 'application/pdf')
    return c.body(Readable.toWeb(doc as unknown as Readable) as ReadableStream)
  },
)

export default app
