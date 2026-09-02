/**
 * 行事曆配色：一套「顏色各有職責」的規則，而不是一堆好看的顏色。
 *
 *   深褐 ink      → 已排定的專案會議（我們自己的東西，最強）
 *   成員色        → 別人的忙碌時段（身分區分）
 *   蜂蜜 honey    → 可以動手的共同空檔（唯一的「行動色」，所以不給別人用）
 *   critical 紅   → 衝突（同一人兩個事件重疊）
 *
 * 成員色只有四個，是量出來的不是挑出來的。行事曆上任兩位成員的色塊都可能相鄰，
 * 所以要用 all-pairs 標準驗；四色（藍/橘/青/紫）在 paper 底色 #FFFDF7 上
 * 全數通過色盲分離度與一般視覺分離度，加到第五色就會有色對低於門檻。
 * 因此第五位起一律灰階 + 姓名標籤（顏色不再是唯一線索），不自動生成新色。
 */

/** 系列色（成員 / 專案共用同一組，固定順序配發，不循環）。 */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7'] as const

/** 第五位起的中性色：可見但不假裝自己是一個「身分色」。 */
export const SERIES_COLOR_OVERFLOW = '#898781'

/** 同時上色的系列數上限；超過的走 {@link SERIES_COLOR_OVERFLOW}。 */
export const SERIES_COLOR_CAP = SERIES_COLORS.length

/** 依序位取色（成員在成員清單中的位置、專案在專案清單中的位置）。 */
export function seriesColorAt(index: number): string {
  return SERIES_COLORS[index] ?? SERIES_COLOR_OVERFLOW
}

/** 衝突標記色（status/critical，不與成員色共用）。 */
export const CONFLICT_COLOR = '#d03b3b'

/** 色塊底色：同一個 hue 的淡填充（8 碼 hex 的 alpha 尾巴）。 */
export function tint(hex: string, alpha: '14' | '22' | '33' = '22'): string {
  return `${hex}${alpha}`
}
