// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemberRow } from '../../../../frontend/src/components/members/member-row'
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

beforeEach(() => vi.clearAllMocks())

describe('MemberRow', () => {
  it('擁有者可見三個權限 checkbox，檢視永遠勾選且不可取消（disabled）', () => {
    renderRow(makeMember({ canView: true, canEdit: true }), true)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    // 順序：檢視（鎖定）/ 編輯 / 會議
    expect(boxes[0]).toBeChecked()
    expect(boxes[0]).toBeDisabled()
    expect(boxes[1]).toBeChecked() // 編輯
    expect(boxes[2]).not.toBeChecked() // 會議
  })

  it('勾選原本關閉的「編輯」→ 呼叫 onUpdate 帶 canEdit', async () => {
    const user = userEvent.setup()
    const { onUpdate } = renderRow(makeMember(), true)
    await user.click(screen.getAllByRole('checkbox')[1]) // 編輯
    expect(onUpdate).toHaveBeenCalledWith(2, { canEdit: true })
  })

  it('非管理者 → 不顯示 checkbox，只顯示唯讀 badge', () => {
    renderRow(makeMember({ canView: true }), false)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText('檢視')).toBeInTheDocument()
  })
})
