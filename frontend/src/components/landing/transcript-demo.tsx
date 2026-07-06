/**
 * 招牌元素：模擬 Google Meet 會議中的即時逐字稿。
 * 對話逐行浮現 → 有人喊出喚醒詞「蜜塔」→ 蜜塔回答 → 摘要生成。
 * 純 CSS 動畫（mb-line），reduced-motion 下直接顯示完整對話。
 */

const LINES = [
  { t: '10:02', who: 'Ken（產品）', text: '上次跟供應商談的單價是多少？' },
  { t: '10:02', who: 'Amy（設計）', text: '我記得後來有再改過⋯⋯' },
  {
    t: '10:03',
    who: 'Ken（產品）',
    text: '，上次定的單價是多少？',
    wake: true,
  },
  {
    t: '10:03',
    who: '蜜塔',
    text: '5 月 28 日的會議結論：單價 $4.2，滿 10K 件降為 $3.9。',
    bot: true,
  },
]

const STEP = 0.9 // 每行出現的間隔（秒）

export function TranscriptDemo() {
  return (
    <figure
      aria-label="示意：蜜塔在 Google Meet 會議中即時回答問題"
      className="rounded-2xl bg-hive p-5 shadow-xl shadow-ink/20 sm:p-6"
    >
      {/* 視窗列：仿 Meet 會議資訊 */}
      <figcaption className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
        <span className="flex items-center gap-2 text-xs text-hive-muted">
          <span className="size-2 rounded-full bg-honey" aria-hidden="true" />
          會議進行中
        </span>
        <span translate="no" className="font-mono text-xs text-hive-faint">
          meet.google.com/abc-defg-hij
        </span>
      </figcaption>

      <ul className="space-y-4">
        {LINES.map((line, i) => (
          <li
            key={i}
            className="mb-line flex gap-3"
            style={{ '--d': `${0.4 + i * STEP}s` } as React.CSSProperties}
          >
            <span className="shrink-0 pt-0.5 font-mono text-xs leading-5 text-hive-faint">
              {line.t}
            </span>
            <p className="text-sm leading-6 text-hive-fg">
              <span
                className={
                  line.bot
                    ? 'font-medium text-honey'
                    : 'font-medium text-hive-muted'
                }
              >
                {line.who}：
              </span>
              {line.wake && (
                <mark className="bg-transparent font-medium text-honey">
                  蜜塔
                </mark>
              )}
              {line.text}
            </p>
          </li>
        ))}
      </ul>

      {/* 會議結束 → 摘要生成 */}
      <div
        className="mb-line mt-5 border-t border-white/10 pt-4"
        style={{ '--d': `${0.4 + LINES.length * STEP + 0.6}s` } as React.CSSProperties}
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-hive-muted">
          <span className="font-mono text-hive-faint">11:14</span>
          <span>會議結束</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-honey/15 px-2.5 py-1 font-medium text-honey">
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 6.5 4.5 9 10 3" />
            </svg>
            摘要已生成 — 3 項決議、2 項待辦
          </span>
        </p>
      </div>
    </figure>
  )
}
