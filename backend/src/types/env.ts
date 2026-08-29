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
  // OpenAI server_vad 的斷句門檻（毫秒）：靜音超過這麼久就判定「這句講完了」→ 定稿。
  // 這是**唯一**決定句子在哪裡被切開的參數。太短（500）中文的自然停頓就會把一句話
  // 切成好幾段；太長則定稿變慢。快速確認（ack）走 partial、不等定稿，所以調大不影響
  // 「聽見我收到了」的時間。⚠️ 多人混音時串流裡幾乎不存在靜音，調這個幫助有限。
  STT_SILENCE_DURATION_MS: z.coerce.number().default(500),
  // 獨立音軌探針（耳朵／嘴巴分家的可行性驗證）。'on' 時 bot 加掛
  // recording_config.audio_separate_raw，Recall 把**每位與會者各自一條**的 PCM
  // 推到 /ws/recall-audio。目前只統計、只寫 log、不做轉錄。
  // 'off'（預設）：join payload 完全不變。需要 RECALL_WEBHOOK_URL（換算成 wss://）。
  RECALL_SEPARATE_AUDIO: z.enum(['on', 'off']).default('off'),
  // 轉錄來源：'mixed'（預設，現行行為——Output Media 網頁的單軌混音）或
  // 'per-track'（Recall audio_separate_raw，每位與會者各自一條音軌分別轉錄）。
  //
  // per-track 的價值是**講者身分變成已知的**：混音沒有講者標記，現在只能靠
  // speaker-timeline 回看 15 秒窗猜「剛才那句是誰講的」，多人會議常猜錯（實測 2026-08-18
  // 四人會議整場幾乎都判歧義）。per-track 直接拿 Recall 給的 participant.name。
  //
  // 代價：每位與會者一條 OpenAI 轉錄連線（四人會議＝4 條），STT 成本約 N 倍。
  // 實測靜音佔比 0.81-0.95，但**不能靠丟棄靜音封包省錢**——server_vad 要「看到」靜音
  // 才知道一句話講完了，丟掉會永遠不定稿。要節流得用 speech_on/off 開關整條連線。
  //
  // 需要 RECALL_SEPARATE_AUDIO=on 與 agent 模式齊全（見 isPerTrackMode）；
  // 任一條件不足會自動退回 mixed，不會變啞巴。
  TRANSCRIBE_MODE: z.enum(['mixed', 'per-track']).default('mixed'),
  // 打斷策略：她講話時，什麼情況該讓路。
  //
  // 'stop-only'（預設）：**只有明確叫停能打斷她**。旁人交談、附和、提問者的尾音
  //   一律不讓路。這是 demo 用的安全設定——寧可她把話講完，也不要被雜訊切掉半句。
  //   實測 2026-08-18 的誤打斷率 47%（開口 154 次被打斷 73 次），其中 86% 的觸發
  //   內容是與會者彼此講話被切出來的 6 字以下碎片，這個模式把那 86% 全部消掉。
  //
  // 'adaptive'：現行的完整策略——講者閘門（提問者／旁人不同字數門檻）、開口寬限期、
  //   延後定案（先暫停、看對方有沒有繼續講，沒有就自己接回去）。她會試著判斷
  //   「這是真的打斷還是附和」，但判錯的代價是話講到一半被切掉。
  //
  // 兩個模式的叫停路徑完全相同：叫停一律繞過所有閘門，立即停聲。
  BARGE_IN_MODE: z.enum(['stop-only', 'adaptive']).default('stop-only'),
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