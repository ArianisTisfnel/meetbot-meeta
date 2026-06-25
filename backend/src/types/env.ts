import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1),
  DIFY_API_BASE: z.string().url(),
  DIFY_DATASET_API_KEY: z.string().min(1),
  DIFY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_SUMMARY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_CHATFLOW_TIMEOUT_MS: z.coerce.number().default(45_000),
  ANTHROPIC_API_KEY: z.string().min(1),
  VEXA_API_URL: z.string().url(),
  VEXA_WS_URL: z.string().url(),
  // ── Meeting Bot Provider failover ──────────────────────────────────────────
  // Recall.ai（fallback provider）。皆為 optional：未設定時系統只用 Vexa（無 failover），
  // 功能照常 end-to-end。兩者都設定後，Vexa 派 bot 被擋時自動 fallback 到 Recall。
  RECALL_API_URL: z.string().url().optional(),
  RECALL_API_KEY: z.string().min(1).optional(),
  // RecallAdapter.speak 用的 TTS（text → mp3）。未設定時 Recall bot 無法說話（known limitation）。
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Recall 即時逐字稿/聊天 webhook：Recall 會主動 POST 進來，故需公開可達的 base URL（本機用 ngrok）。
  // 未設定 → realtime 關閉，Recall 退回 meeting_captions（只有會後逐字稿、無喚醒詞即時問答）。
  RECALL_WEBHOOK_URL: z.string().url().optional(),
  // webhook 共享密鑰（放 ?token= 查詢參數驗證 Recall 來源）。
  RECALL_WEBHOOK_TOKEN: z.string().min(1).optional(),
  // recallai_streaming（prioritize_accuracy 模式）的轉錄語言碼：
  // 'auto' = 自動偵測、可中英夾雜（推薦）；或指定如 'zh'（中文）、'en'。'multi' 非合法值。
  RECALL_TRANSCRIBE_LANGUAGE: z.string().default('auto'),
  // Vexa：等待 bot 真正被 admitted 進會議的逾時（毫秒）；逾時即視為「被擋在門外」並觸發 failover。
  BOT_ADMISSION_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Recall：admission 逾時。Recall bot 從派出到進等候室本身就要約 30s（實測），
  // 故給較長的視窗，避免 failover 後 Recall 還沒進場就被判逾時。
  RECALL_ADMISSION_TIMEOUT_MS: z.coerce.number().default(90_000),
  APP_PORT: z.coerce.number().default(4000),
  APP_CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // 前端基底 URL，用於組出邀請接受連結。
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  // 寄信（邀請信）設定。皆為 optional：未設定時 EmailService 退回「只印 log」模式，
  // 功能照常 end-to-end，僅不會真的寄出 email。
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().optional(),
  // 邀請過期天數。
  INVITATION_TTL_DAYS: z.coerce.number().default(7),
})

const result = envSchema.safeParse(process.env)
if (!result.success) {
  console.error('Invalid environment variables:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = result.data