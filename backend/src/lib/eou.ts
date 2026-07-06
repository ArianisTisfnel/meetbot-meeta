import fs from 'node:fs'
import path from 'node:path'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { logger } from '../middleware/logger.js'

/**
 * LiveKit turn-detector（EOU, end-of-utterance）模型 — 插話引擎「時機層」的語意判斷。
 *
 * 模型：huggingface.co/livekit/turn-detector（Apache-2.0），多語版 revision v0.4.1-intl
 * （支援中文）。輸入最近幾輪對話文字，輸出「目前說話者已講完」的機率——
 * 取代「死等固定秒數」的停頓計時，讓插話時機接近真人。
 *
 * 推論配方對齊官方 python plugin（livekit-plugins-turn-detector base.py）：
 *   1. 最近 ≤6 輪對話 → chat template 格式化（add_generation_prompt=false）
 *   2. NFKC 正規化、轉小寫、去標點（保留 ' 與 -）
 *   3. 移除最後一個 <|im_end|>（讓模型判斷「這句還沒結束」的機率）
 *   4. tokenize 後取最後 128 token（左截斷），跑 ONNX（模型直接輸出機率，取最後一個值）
 *   5. 與 languages.json 的 per-language 閾值比較
 *
 * 所有失敗（下載失敗、推論錯誤）都回傳 null，由呼叫端退回停頓計時 — 模型是增強，不是依賴。
 */

const HF_REPO = 'livekit/turn-detector'
const REVISION = 'v0.4.1-intl'
const MAX_TOKENS = 128
const MAX_TURNS = 6
/** 查不到語言閾值時的保守預設（寧可少插話）。 */
const FALLBACK_THRESHOLD = 0.8

const MODEL_DIR = path.resolve(process.cwd(), 'models', 'turn-detector')
const ONNX_PATH = path.join(MODEL_DIR, 'model_q8.onnx')
const LANGUAGES_PATH = path.join(MODEL_DIR, 'languages.json')

export interface EouTurn {
  role: 'user' | 'assistant'
  content: string
}

interface EouRuntime {
  session: import('onnxruntime-node').InferenceSession
  tokenizer: any
  thresholds: Record<string, { threshold: number }>
}

let runtimePromise: Promise<EouRuntime | null> | null = null

async function downloadIfMissing(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  logger.info({ url, dest }, 'eou: downloading model file (first run only)')
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`eou download failed ${res.status}: ${url}`)
  const tmp = `${dest}.tmp`
  await streamPipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

async function initRuntime(): Promise<EouRuntime | null> {
  try {
    const base = `https://huggingface.co/${HF_REPO}/resolve/${REVISION}`
    await downloadIfMissing(`${base}/onnx/model_q8.onnx`, ONNX_PATH)
    await downloadIfMissing(`${base}/languages.json`, LANGUAGES_PATH)

    const [{ InferenceSession }, { AutoTokenizer }] = await Promise.all([
      import('onnxruntime-node'),
      import('@huggingface/transformers'),
    ])

    const [session, tokenizer] = await Promise.all([
      InferenceSession.create(ONNX_PATH),
      AutoTokenizer.from_pretrained(HF_REPO, { revision: REVISION }),
    ])
    const thresholds = JSON.parse(fs.readFileSync(LANGUAGES_PATH, 'utf-8'))

    logger.info({ revision: REVISION }, 'eou: LiveKit turn-detector model ready')
    return { session, tokenizer, thresholds }
  } catch (err) {
    logger.warn({ err }, 'eou: model init failed — falling back to silence-based turn detection')
    return null
  }
}

/** 預熱（下載＋載入模型）。啟用 livekit 時機層時於啟動階段呼叫，避免第一場會議才付下載成本。 */
export function warmEouModel(): void {
  if (!runtimePromise) runtimePromise = initRuntime()
}

/** 對齊官方前處理：NFKC → 小寫 → 去標點（保留 ' -）→ 壓縮空白。 */
export function normalizeEouText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (m) => (m === "'" || m === '-' ? m : ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 語言閾值（languages.json；查不到用保守預設）。 */
export function eouThreshold(thresholds: Record<string, { threshold: number }>, lang: string): number {
  const key = lang.toLowerCase()
  return thresholds[key]?.threshold ?? thresholds[key.split('-')[0]]?.threshold ?? FALLBACK_THRESHOLD
}

/**
 * 「目前說話者已講完」的機率是否達到插話閾值。
 * @param thresholdOverride 覆蓋 languages.json 的閾值。官方值為語音助理「要快回」調校
 *   （zh=0.0066，很寬鬆）；插話場景實測：清楚講完 ≥0.68、沒講完 ≤0.008，建議 0.1 左右保守值。
 * @returns true/false = 模型判斷；null = 模型不可用（呼叫端退回停頓計時）
 */
export async function isEndOfTurn(
  turns: EouTurn[],
  lang: string,
  thresholdOverride?: number,
): Promise<boolean | null> {
  if (!runtimePromise) runtimePromise = initRuntime()
  const rt = await runtimePromise
  if (!rt || !turns.length) return null

  try {
    // 合併相鄰同角色、取最後 MAX_TURNS 輪、逐則正規化
    const merged: EouTurn[] = []
    for (const t of turns) {
      const content = normalizeEouText(t.content)
      if (!content) continue
      const last = merged[merged.length - 1]
      if (last && last.role === t.role) last.content += ` ${content}`
      else merged.push({ role: t.role, content })
    }
    const recent = merged.slice(-MAX_TURNS)
    if (!recent.length) return null

    let text: string = rt.tokenizer.apply_chat_template(recent, {
      add_generation_prompt: false,
      tokenize: false,
    })
    // 移除最後一個 <|im_end|>，讓模型評估「這句話結束了嗎」
    const ix = text.lastIndexOf('<|im_end|>')
    if (ix >= 0) text = text.slice(0, ix)

    const encoded = rt.tokenizer(text, { add_special_tokens: false })
    let ids: bigint[] = Array.from(encoded.input_ids.data as BigInt64Array)
    if (ids.length > MAX_TOKENS) ids = ids.slice(-MAX_TOKENS) // 左截斷

    const { Tensor } = await import('onnxruntime-node')
    const input = new Tensor('int64', BigInt64Array.from(ids), [1, ids.length])
    const outputs = await rt.session.run({ input_ids: input })
    const out = outputs[rt.session.outputNames[0]].data as Float32Array
    const probability = Number(out[out.length - 1])

    const threshold = thresholdOverride ?? eouThreshold(rt.thresholds, lang)
    logger.info({ probability, threshold, lang }, 'eou: end-of-turn probability')
    return probability >= threshold
  } catch (err) {
    logger.warn({ err }, 'eou: inference failed — falling back to silence-based turn detection')
    return null
  }
}
