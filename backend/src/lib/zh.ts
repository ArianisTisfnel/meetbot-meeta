import * as OpenCC from 'opencc-js'

/**
 * 簡體 → 繁體（台灣用語）轉換。
 *
 * 為什麼需要：Recall 的 recallai_streaming 只支援通用 `zh`（無 zh-TW），
 * 轉錄結果常混出簡體字；Dify/LLM 輸出偶爾也會夾簡體。
 * 產品要求一律繁體中文，因此在後端統一做確定性轉換：
 * - 逐字稿：normalize 層（Recall realtime / 最終逐字稿）
 * - 摘要/重點主題/待辦：Dify 輸出後
 *
 * OpenCC 對已是繁體或非中文的文字為 no-op，可安全套用在所有文字上。
 */
const converter = OpenCC.Converter({ from: 'cn', to: 'twp' })

export function toTraditional(text: string): string {
  if (!text) return text
  return converter(text)
}
