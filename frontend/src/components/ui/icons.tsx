import { cn } from '@/lib/utils'

/**
 * 蜜塔統一線條圖示集：16px viewBox、1.5 stroke、currentColor。
 * 取代散落各處、與品牌色系衝突的 emoji。
 */

interface IconProps {
  className?: string
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn('size-4 shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export function FolderIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
    </Svg>
  )
}

export function MeetingIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="4" width="9" height="8" rx="1" />
      <path d="m10.5 7 4-2v6l-4-2" />
    </Svg>
  )
}

export function DocIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 2.5a1 1 0 0 1 1-1H9l3.5 3.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" />
      <path d="M9 1.5V5h3.5" />
    </Svg>
  )
}

export function PeopleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5.5" cy="5.5" r="2.25" />
      <path d="M1.5 13c.5-2.5 2-3.75 4-3.75s3.5 1.25 4 3.75" />
      <path d="M10 3.5a2.25 2.25 0 0 1 0 4" />
      <path d="M11 9.5c1.8.3 3 1.4 3.5 3.5" />
    </Svg>
  )
}

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Svg>
  )
}

export function TrashIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11" />
      <path d="M5.5 4V2.5h5V4" />
      <path d="m4 4 .6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" />
      <path d="M6.5 7v4M9.5 7v4" />
    </Svg>
  )
}

export function UploadIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 10.5V2.5" />
      <path d="m4.5 6 3.5-3.5L11.5 6" />
      <path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
    </Svg>
  )
}

export function MailIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
      <path d="m1.5 5 6.5 4 6.5-4" />
    </Svg>
  )
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1" />
      <path d="M10.5 5.5v-3a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3" />
    </Svg>
  )
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m10.5 2.5 3 3L5.5 13.5H2.5v-3z" />
    </Svg>
  )
}

export function WarningIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5V10" />
      <path d="M8 12h.01" />
    </Svg>
  )
}

export function ArrowLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.5 8h-11" />
      <path d="m6.5 4-4 4 4 4" />
    </Svg>
  )
}

export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  )
}

export function MinusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h10" />
    </Svg>
  )
}

export function SlidersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5h6M12.5 5h1M2.5 11h1M7.5 11h6" />
      <circle cx="10.5" cy="5" r="1.5" />
      <circle cx="5" cy="11" r="1.5" />
    </Svg>
  )
}

export function PanelLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M6 2.5v11" />
    </Svg>
  )
}

export function LogoutIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6" />
      <path d="m10.5 11 3-3-3-3" />
      <path d="M13.5 8H6" />
    </Svg>
  )
}
