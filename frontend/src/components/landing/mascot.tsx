import { cn } from '@/lib/utils'

/**
 * 蜜塔 Meeta 吉祥物：直接用 asset/ 下的角色插畫，別再手刻 SVG 形狀。
 *
 * 檔案在 public/mascot/，是原稿裁掉標註文字（FRONT / 3-4 VIEW）後的版本，
 * viewBox 已各自裁成正方形，所以四個 pose 在同一個 size-* 下大小一致。
 */

export type MascotPose = 'front' | 'work' | 'sleep' | 'fly'

export function Mascot({
  pose = 'front',
  className,
}: {
  pose?: MascotPose
  className?: string
}) {
  return (
    <img
      src={`/mascot/${pose}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('size-40 select-none', className)}
    />
  )
}
