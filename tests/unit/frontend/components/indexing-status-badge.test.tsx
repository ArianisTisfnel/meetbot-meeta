// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IndexingStatusBadge } from '../../../../frontend/src/components/materials/indexing-status-badge'

// 避免實際呼叫 API：useMaterialStatus 回傳 initialStatus 作為 indexingStatus
vi.mock('../../../../frontend/src/hooks/use-materials', () => ({
  useMaterialStatus: vi.fn((_projectId: string, _materialId: string) => ({
    data: undefined,
  })),
}))

describe('IndexingStatusBadge', () => {
  const defaultProps = {
    projectId: 'project-1',
    materialId: 'material-1',
  }

  it('PENDING → 顯示「等待中」', () => {
    render(
      <IndexingStatusBadge {...defaultProps} initialStatus="PENDING" />
    )
    expect(screen.getByText('等待中')).toBeInTheDocument()
  })

  it('PROCESSING → 顯示「索引中」', () => {
    render(
      <IndexingStatusBadge {...defaultProps} initialStatus="PROCESSING" />
    )
    expect(screen.getByText('索引中')).toBeInTheDocument()
  })

  it('COMPLETED → 顯示「索引完成」', () => {
    render(
      <IndexingStatusBadge {...defaultProps} initialStatus="COMPLETED" />
    )
    expect(screen.getByText('索引完成')).toBeInTheDocument()
  })

  it('FAILED → 顯示「索引失敗」', () => {
    render(
      <IndexingStatusBadge {...defaultProps} initialStatus="FAILED" />
    )
    expect(screen.getByText('索引失敗')).toBeInTheDocument()
  })
})
