import { describe, it, expect } from 'vitest'
import { canSeeJoinLink, visibleJoinUrl } from '../../../../backend/src/lib/meeting-access'

const URL = 'https://meet.google.com/abc-defg-hij'

describe('canSeeJoinLink', () => {
  it('建立者看得到', () => {
    expect(
      canSeeJoinLink({ viewerUserId: 1, createdByUserId: 1, attendeeUserIds: [1, 2] }),
    ).toBe(true)
  })

  it('被列為與會者的人看得到', () => {
    expect(
      canSeeJoinLink({ viewerUserId: 2, createdByUserId: 1, attendeeUserIds: [1, 2] }),
    ).toBe(true)
  })

  it('沒被列入的人看不到', () => {
    expect(
      canSeeJoinLink({ viewerUserId: 3, createdByUserId: 1, attendeeUserIds: [1, 2] }),
    ).toBe(false)
  })

  it('沒有與會者名單時一律放行——直接建立的即時會議從來沒有與會者概念，' +
    '套用「必須在名單內」等於偷偷改掉既有流程', () => {
    expect(
      canSeeJoinLink({ viewerUserId: 99, createdByUserId: 1, attendeeUserIds: [] }),
    ).toBe(true)
  })

  it('建立者不在自己的與會者名單裡也看得到（防禦：名單被改壞時不該把主辦鎖在外面）', () => {
    expect(
      canSeeJoinLink({ viewerUserId: 1, createdByUserId: 1, attendeeUserIds: [2, 3] }),
    ).toBe(true)
  })
})

describe('visibleJoinUrl', () => {
  it('看得到時回原本的連結', () => {
    expect(
      visibleJoinUrl(URL, { viewerUserId: 2, createdByUserId: 1, attendeeUserIds: [1, 2] }),
    ).toBe(URL)
  })

  it('看不到時回空字串——前端一律以「有沒有值」判斷要不要顯示加入入口', () => {
    expect(
      visibleJoinUrl(URL, { viewerUserId: 3, createdByUserId: 1, attendeeUserIds: [1, 2] }),
    ).toBe('')
  })
})
