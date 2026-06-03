import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../types/env.js'
import { logger } from '../middleware/logger.js'

/**
 * EmailService：抽象寄信能力。
 *
 * - 若 .env 設定了 SMTP_HOST（搭配 Gmail 應用程式密碼最簡單），則透過 SMTP 真實寄出。
 * - 若未設定，退回「只把內容印到 log」的 fallback，讓邀請功能不依賴寄信即可 end-to-end 運作。
 *
 * 所有寄信皆 best-effort：失敗只記 log，不拋錯影響主流程。
 */

let transporter: Transporter | null = null
let transporterReady = false

function getTransporter(): Transporter | null {
  if (transporterReady) return transporter
  transporterReady = true

  if (!env.SMTP_HOST) {
    transporter = null
    return null
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE ?? false,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
  })
  return transporter
}

function mailFrom(): string {
  return env.MAIL_FROM ?? env.SMTP_USER ?? 'MeetBot <no-reply@meetbot.local>'
}

export interface SendInvitationParams {
  to: string
  projectName: string
  inviterName: string
  acceptUrl: string
  expiresAt: Date
}

/**
 * 寄出專案邀請信。回傳 true 表示已透過 SMTP 寄出，false 表示退回 log 模式（未設定 SMTP）。
 */
export async function sendInvitationEmail(params: SendInvitationParams): Promise<boolean> {
  const { to, projectName, inviterName, acceptUrl, expiresAt } = params
  const tx = getTransporter()

  if (!tx) {
    logger.info(
      { to, projectName, acceptUrl, expiresAt },
      '[email] SMTP 未設定，邀請信改印於 log（請手動把 acceptUrl 給對方）',
    )
    return false
  }

  const expiresText = expiresAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
  const subject = `${inviterName} 邀請你加入 MeetBot 專案「${projectName}」`
  const text = [
    `${inviterName} 邀請你加入 MeetBot 專案「${projectName}」。`,
    '',
    `請點以下連結，使用此 email 登入後即可接受邀請：`,
    acceptUrl,
    '',
    `此連結將於 ${expiresText} 過期。`,
    '',
    `若你並未預期收到此邀請，請忽略本信。`,
  ].join('\n')

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;color:#1f2937">
      <h2 style="font-size:18px">🤖 MeetBot 專案邀請</h2>
      <p><strong>${escapeHtml(inviterName)}</strong> 邀請你加入專案「<strong>${escapeHtml(projectName)}</strong>」。</p>
      <p>請使用此 email 登入後接受邀請：</p>
      <p style="margin:24px 0">
        <a href="${acceptUrl}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">接受邀請</a>
      </p>
      <p style="font-size:13px;color:#6b7280">此連結將於 ${escapeHtml(expiresText)} 過期。若你並未預期收到此邀請，請忽略本信。</p>
    </div>`

  try {
    await tx.sendMail({ from: mailFrom(), to, subject, text, html })
    logger.info({ to, projectName }, '[email] 邀請信已寄出')
    return true
  } catch (err: unknown) {
    logger.error({ err, to }, '[email] 邀請信寄送失敗')
    return false
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
