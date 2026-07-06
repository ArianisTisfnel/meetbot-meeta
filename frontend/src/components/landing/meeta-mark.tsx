import { cn } from '@/lib/utils'

/** 蜜塔品牌標記：兩個堆疊的蜂巢六角形（蜜 + 塔） */
export function MeetaMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn('size-8', className)}
    >
      <path
        d="M21 3.5 28.5 8v9L21 21.5 13.5 17V8z"
        fill="#E89B0C"
      />
      <path
        d="M12 12.5 19.5 17v9L12 30.5 4.5 26v-9z"
        fill="none"
        stroke="#271C0E"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
