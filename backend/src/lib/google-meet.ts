/**
 * 從 Google Meet URL 擷取 native meeting ID（e.g. "abc-defg-hij"）。
 * 支援格式：https://meet.google.com/xxx-xxxx-xxx 或 xxx-xxxx-xxx
 * 回傳 null 代表格式不符。
 */
export function parseGoogleMeetUrl(url: string): string | null {
  const match = url.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)
  return match ? match[1].toLowerCase() : null
}
