// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PermissionGuard } from '../../../../frontend/src/components/permission-guard'
import type { UserPermissions } from '../../../../frontend/src/types/api'

// 預設回傳全 false 權限，各 test 可覆寫
const mockPermissions: UserPermissions = {
  canView: false,
  canEdit: false,
  canDelete: false,
  canManage: false,
  canMeeting: false,
}

vi.mock('../../../../frontend/src/hooks/use-permissions', () => ({
  usePermissions: vi.fn(() => mockPermissions),
}))

import { usePermissions } from '../../../../frontend/src/hooks/use-permissions'

describe('PermissionGuard', () => {
  it('權限符合 → 渲染 children', () => {
    vi.mocked(usePermissions).mockReturnValueOnce({
      ...mockPermissions,
      canDelete: true,
    })

    render(
      <PermissionGuard projectId="p1" require="canDelete">
        <span>刪除按鈕</span>
      </PermissionGuard>
    )

    expect(screen.getByText('刪除按鈕')).toBeInTheDocument()
  })

  it('權限不符 → 不渲染 children（預設 fallback 為 null）', () => {
    vi.mocked(usePermissions).mockReturnValueOnce({
      ...mockPermissions,
      canDelete: false,
    })

    render(
      <PermissionGuard projectId="p1" require="canDelete">
        <span>刪除按鈕</span>
      </PermissionGuard>
    )

    expect(screen.queryByText('刪除按鈕')).not.toBeInTheDocument()
  })

  it('權限不符 + 提供 fallback → 渲染 fallback', () => {
    vi.mocked(usePermissions).mockReturnValueOnce({
      ...mockPermissions,
      canManage: false,
    })

    render(
      <PermissionGuard
        projectId="p1"
        require="canManage"
        fallback={<span>無權限提示</span>}
      >
        <span>邀請按鈕</span>
      </PermissionGuard>
    )

    expect(screen.queryByText('邀請按鈕')).not.toBeInTheDocument()
    expect(screen.getByText('無權限提示')).toBeInTheDocument()
  })
})
