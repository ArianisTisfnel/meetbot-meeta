import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  // MinIO 不檢查這個值，但 AWS SDK v3 的 SigV4 簽章需要一個 region。
  S3_REGION: z.string().default('us-east-1'),
  DIFY_API_BASE: z.string().url(),
  DIFY_DATASET_API_KEY: z.string().min(1),
  DIFY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_SUMMARY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_MEETING_SUMMARY_WORKFLOW_API_KEY: z.string().min(1),
  DIFY_CHATFLOW_TIMEOUT_MS: z.coerce.number().default(45_000),
  ANTHROPIC_API_KEY: z.string().min(1),
  // 設定後，插話決策/無知識庫問答改走 Gemini（AI Studio 免費額度）而非 Anthropic。
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  // 插話/破冰專用的第二把 Gemini key（另一個帳號的免費額度）。未設定時退回 GEMINI_API_KEY。
  // 目的：插話決策每輪講話都會打 LLM、最燒額度，用獨立帳號隔離，燒完不拖垮其他功能。
  GEMINI_INTERJECTION_API_KEY: z.string().optional(),
  // 新帳號不能用 gemini-2.5-flash（對新用戶停開），預設用 lite 系列 alias。
  GEMINI_INTERJECTION_MODEL: z.string().default('gemini-flash-lite-latest'),
  // ── Meeting Bot Provider ────────────────────────────────────────────────────
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
  // ── Output Media 即時語音 agent（方案 A，見 docs/16）────────────────────────
  // 'on'：Recall bot 加掛 agent 網頁（耳朵/嘴巴走串流，喚醒 ack 由分鐘級降到秒級）。
  // 'off'（預設）：完全走現行 webhook + mp3 路徑。
  // 真正啟用還需 AGENT_PAGE_URL、OPENAI_API_KEY、RECALL_WEBHOOK_URL/TOKEN 齊全。
  AGENT_MODE: z.enum(['on', 'off']).default('off'),
  // agent 網頁（前端 /agent）的公開 URL；bot 的雲端瀏覽器會開啟它，需外網可達。
  AGENT_PAGE_URL: z.string().url().optional(),
  // Recall：admission 逾時（ms）。Recall bot 從派出到進等候室本身就要約 30s（實測），
  // 故給較長的視窗。
  RECALL_ADMISSION_TIMEOUT_MS: z.coerce.number().default(90_000),
  // ── 主動插話（interjection）─────────────────────────────────────────────────
  // 蜜塔在「沒被叫名字」時也會判斷是否主動用聊天室補充（RAG 答得出的問題才插話）。
  INTERJECTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // 判定「一輪話講完」的停頓門檻（ms）：最後一段語音後多久沒新內容才評估要不要插話。
  INTERJECTION_TURN_SILENCE_MS: z.coerce.number().default(2_500),
  // 時機層：'silence'（純停頓計時）或 'livekit'（LiveKit turn-detector 模型語意判斷，
  // 講完就提早評估；模型不可用時自動退回停頓計時）。首次啟用會下載 ~150MB 模型。
  INTERJECTION_TURN_DETECTOR: z.enum(['silence', 'livekit']).default('silence'),
  // livekit 模式：短暫靜默多久後先問 EOU 模型（ms）。
  INTERJECTION_EOU_CHECK_MS: z.coerce.number().default(1_000),
  // EOU 閾值查表用語言碼（languages.json）。
  INTERJECTION_EOU_LANGUAGE: z.string().default('zh'),
  // EOU 閾值（覆蓋 languages.json）。官方 zh=0.0066 偏寬鬆（語音助理調校）；
  // 插話場景實測講完 ≥0.68、沒講完 ≤0.008 → 預設 0.1 保守值。
  INTERJECTION_EOU_THRESHOLD: z.coerce.number().default(0.1),
  // 兩次主動插話之間的最小間隔（ms），避免蜜塔變話癆。
  INTERJECTION_COOLDOWN_MS: z.coerce.number().default(90_000),
  // ── 沉默破冰（icebreaker）───────────────────────────────────────────────────
  // 全場沉默超過門檻，蜜塔主動開口（開場=罐頭引導；會議中=總結+拋問題）。
  ICEBREAKER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ICEBREAKER_SILENCE_MS: z.coerce.number().default(40_000),
  ICEBREAKER_COOLDOWN_MS: z.coerce.number().default(300_000),
  // ── 回覆功能標籤（reply tags）────────────────────────────────────────────────
  // 'on'（預設）：蜜塔的聊天室訊息前面標【資料檢索】【冷場插話】【破冰】等，
  // 讓每則回覆可歸因到觸發它的子系統（除錯與回應品質評估的前提）。
  // 'off'：正式對外會議不想露出除錯資訊時關閉。語音永遠不唸標籤，不受此開關影響。
  REPLY_TAGS: z.enum(['on', 'off']).default('on'),
  // 內部信任端點（前端 NextAuth 登入取得 authToken）共享密鑰；未設定＝端點停用。
  INTERNAL_AUTH_SECRET: z.string().min(16).optional(),
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