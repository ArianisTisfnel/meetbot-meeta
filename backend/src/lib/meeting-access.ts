/**
 * 「誰看得到會議的加入連結」的單一判斷。
 *
 * 為什麼獨立成一個檔案：這條規則要同時套用在行事曆與會議列表／詳情四個地方，
 * 而 calendar.service 已經 import meeting.service（權限 helper），
 * 放在任一邊都會製造循環相依。放這裡兩邊都能用，也保證只有一份定義。
 */

export interface JoinLinkVisibilityParams {
  viewerUserId: number
  createdByUserId: number
  /** 這場會議被明確指定的與會者；空陣列代表「沒有人限制參與者」 */
  attendeeUserIds: number[]
}

/**
 * 主辦挑了與會者，就代表其他人不該進這場會——把連結發給整個專案等於那份挑選沒有意義。
 *
 * 但**沒有與會者名單時一律放行**：直接建立的即時會議（走 createMeeting，不經行事曆）
 * 從來就沒有與會者概念，對它套用「必須在名單內」會讓連結只剩建立者看得到，
 * 等於偷偷改掉既有流程的行為。有名單才有限制，沒名單就是沒限制。
 */
export function canSeeJoinLink(params: JoinLinkVisibilityParams): boolean {
  const { viewerUserId, createdByUserId, attendeeUserIds } = params
  if (attendeeUserIds.length === 0) return true
  return createdByUserId === viewerUserId || attendeeUserIds.includes(viewerUserId)
}

/** 依可見性決定要回真正的連結還是空字串。 */
export function visibleJoinUrl(
  googleMeetUrl: string,
  params: JoinLinkVisibilityParams,
): string {
  return canSeeJoinLink(params) ? googleMeetUrl : ''
}
