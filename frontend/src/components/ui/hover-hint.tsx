'use client'
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  hint: string
  children: ReactNode
}

const TOOLTIP_WIDTH = 256 // = w-64

/**
 * 透過 portal 將提示渲染到 document.body，並以 fixed 定位，
 * 因此不會被任何 overflow 容器（如列表的 overflow-x-auto）裁切。
 * 依視窗下方剩餘空間自動往下或往上翻。
 */
export function HoverHint({ hint, children }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  const show = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TOOLTIP_WIDTH - 8))
    // 下方空間不足時，改翻到上方
    if (window.innerHeight - r.bottom < 120) {
      setStyle({ position: 'fixed', left, top: r.top - 6, transform: 'translateY(-100%)' })
    } else {
      setStyle({ position: 'fixed', left, top: r.bottom + 6 })
    }
  }
  const hide = () => setStyle(null)

  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="inline-block"
    >
      {children}
      {style &&
        createPortal(
          <span
            role="tooltip"
            style={style}
            className="pointer-events-none z-50 block w-64 rounded-md bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg"
          >
            {hint}
          </span>,
          document.body,
        )}
    </span>
  )
}
