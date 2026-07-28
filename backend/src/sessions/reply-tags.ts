import { env } from '../types/env.js'

/**
 * 蜜塔回覆的「功能標籤」——讓每則訊息可歸因到觸發它的子系統。
 *
 * 為什麼需要：蜜塔有五條互相獨立的發話路徑（喚醒問答的三種資料來源、主動插話、
 * 沉默破冰），但送到會議聊天室後長得一模一樣。實測回報 2026-07-28：使用者無法判斷
 * 「這句是查了知識庫、還是只看逐字稿掰的、還是根本沒人叫她她自己插話」，
 * 導致回應品質無從評估、改壞了也看不出來。
 *
 * 設計約束（三條都很重要）：
 * 1. **只加在聊天室文字**。語音永遠不唸標籤——唸「資料檢索」違反人設的通道禮儀，
 *    而且 TTS 唸方括號會變成怪聲。
 * 2. **不進 chatLog、不進插話對話窗**。標籤是給人看的除錯前綴，不是會議內容；
 *    混進去會污染決策層/破冰的 LLM 輸入，也會出現在會後逐字稿與摘要裡。
 *    實作上靠 sendChatBestEffort 只在呼叫 provider 的那一刻才前綴。
 * 3. **可關**。REPLY_TAGS=off 時完全不出現（正式對外會議不想讓客戶看到除錯資訊）。
 */

export type ReplyTag =
  /** Dify RAG：查了專案知識庫 */
  | 'rag'
  /** 逐字稿／聊天記錄 QA：沒查知識庫，只看這場會議說過什麼 */
  | 'transcript'
  /** 閒聊直答：完全沒碰知識庫與逐字稿，純 LLM 寒暄 */
  | 'chitchat'
  /** 主動插話：沒人叫她，決策層判斷該補充 */
  | 'interjection'
  /** 沉默破冰：全場靜默觸發 */
  | 'icebreaker'
  /**
   * 收到發言的即時確認。此時還沒分類，**不宣稱要查什麼、也不宣稱那是個問題**——
   * 實測 2026-07-29：對蜜塔說「哈囉」，ack 卻寫「收到…的問題：「哈囉」」，
   * 明明是打招呼不是提問。
   */
  | 'ack'
  /** 被 barge-in 打斷、改用文字把答案補完 */
  | 'deferred'
  /** 查詢失敗 */
  | 'error'

const LABELS: Record<ReplyTag, string> = {
  rag: '【資料檢索】',
  transcript: '【會議記錄】',
  chitchat: '【閒聊】',
  interjection: '【冷場插話】',
  icebreaker: '【破冰】',
  ack: '【收到】',
  deferred: '【接續回覆】',
  error: '【錯誤】',
}

/** 標籤功能是否開啟。env mock 不完整（單元測試）時視為開啟，與 zod 預設一致。 */
export function replyTagsEnabled(): boolean {
  return (env as { REPLY_TAGS?: string }).REPLY_TAGS !== 'off'
}

/**
 * 在聊天室文字前面加上功能標籤。tag 為 undefined 或功能關閉時原樣回傳。
 * 只在「即將送進會議聊天室」的那一刻呼叫——留存用的文字必須是未加標籤的原文。
 */
export function withReplyTag(text: string, tag?: ReplyTag): string {
  if (!tag || !replyTagsEnabled()) return text
  return `${LABELS[tag]}${text}`
}

/**
 * 喚醒問答實際走到的資料來源（ReplyTag 的子集，可直接當標籤用）。
 * resolveAnswerRouted 回傳它，dispatchQuestion 據此標記答案。
 */
export type AnswerRoute = Extract<ReplyTag, 'rag' | 'transcript' | 'chitchat'>
