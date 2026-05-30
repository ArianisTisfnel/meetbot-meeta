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
  APP_PORT: z.coerce.number().default(4000),
  APP_CORS_ORIGINS: z.string().default('http://localhost:3000'),
})

const result = envSchema.safeParse(process.env)
if (!result.success) {
  console.error('Invalid environment variables:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = result.data