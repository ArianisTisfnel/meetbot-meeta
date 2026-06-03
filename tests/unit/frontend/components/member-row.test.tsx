// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemberRow, leavesNoPermission } from '../../../../frontend/src/components/members/member-row'
import type { ProjectMember } from '../../../../frontend/src/types/api'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function makeMember(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    id: 'm1',
    vexaUserId: 2,
    email: 'member@example.com',
    name: '成員',
    canView: true,
    canEdit: false,
    canMeeting: false,
    invitedAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── 全空權限防護（純邏輯）──────────────────────────────────────────────
describe('leavesNoPermission（全空權限防護）', () => {
  it('取消唯一剩下的權限 → true（應被擋）', () => {
    const m = { canView: true, canEdit: false, canMeeting: false }
    expect(leavesNoPermission(m, 'canView', false)).toBe(true)
  })

  it('還有其他權限時取消其中一項 → false（允許）', () => {
    const m = { canView: true, canEdit: true, canMeeting: false }
    expect(leavesNoPermission(m, 'canEdit', false)).toBe(false)
  })

  it('開啟一項權限 → false（永遠允許）', () => {
    const m = { canView: false, canEdit: false, canMeeting: false }
    expect(leavesNoPermission(m, 'canMeeting', true)).toBe(false)
  })
})

// ── 渲染 / 互動 ────────────────────────────────────────────────────────
describe('MemberRow 渲染', () => {
  function renderRow(member: ProjectMember, canManage: boolean) {
    const onUpdate = vi.fn()
    const onRemove = vi.fn()
    render(
      <table>
        <tbody>
          <MemberRow member={member} canManage={canManage} onRemove={onRemove} onUpdate={onUpdate} />
        </tbody>
      </table>,
    )
    return { onUpdate, onRemove }
  }

  it('擁有者可見三個可勾選的權限 checkbox，狀態對應成員權限', () => {
    renderRow(makeMember({ canView: true, canEdit: true }), true)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes[0]).toBeChecked() // 檢視
    expect(boxes[1]).toBeChecked() // 編輯
    expect(boxes[2]).not.toBeChecked() // 會議
  })

  it('勾選一個原本關閉的權限 → 呼叫 onUpdate 帶該欄位', async () => {
    const user = userEvent.setup()
    const { onUpdate } = renderRow(makeMember(), true)
    await user.click(screen.getAllByRole('checkbox')[1]) // canEdit: false → true
    expect(onUpdate).toHaveBeenCalledWith(2, { canEdit: true })
  })

  it('非管理者 → 不顯示 checkbox，只顯示唯讀 badge', () => {
    renderRow(makeMember({ canView: true }), false)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText('檢視')).toBeInTheDocument()
  })
})
