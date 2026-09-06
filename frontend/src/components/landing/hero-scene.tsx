import { Mascot } from './mascot'

/**
 * Hero 招牌場景：提問 → 查資料 → 答案，三段對話輪流播。
 *
 * 刻意**不用 React state**：這是一段固定的示範，用 CSS keyframes 就夠，
 * 不必為了幾個 div 的顯隱把整個 landing 變成 client component（省一份 hydration）。
 * reduced-motion 下只留第一段的最終狀態（見 globals.css 的 mb-scene / mb-q / mb-think / mb-a）。
 */

/**
 * 三段各展示一種**不同**的能力，不要改成同一件事的三個變體：
 *   ① 喊名字問 → 查專案資料（Dify RAG）
 *   ② 追問不必再喊一次名字（backend answerFollowUp）
 *   ③ 沒人叫她時也在聽，沒人回答的問題會補上（backend interjection）
 *
 * ⚠️ 文案準確性：答案只能來自「使用者上傳的專案資料」或「本場會議的逐字稿」，
 * 不要寫成她讀過歷史會議記錄。
 */
const SCENES = [
  {
    ask: '蜜塔，報價單上的單價是多少？',
    thinking: '正在翻專案資料',
    at: '10:03',
    answer: '報價單 v3 寫：單價 $4.2，滿 10K 件降至 $3.9。',
    tag: '查到了',
  },
  {
    ask: '那交期呢？',
    thinking: '接續剛剛那一題',
    at: '10:04',
    answer: '同一份報價單：14 個工作天，急件 7 天加收 15%。',
    tag: '追問不用再喊名字',
  },
  {
    ask: '延遲上限規格書有寫嗎……有人記得嗎？',
    thinking: '沒人回答，蜜塔接話',
    at: '10:21',
    answer: '規格書 §4.2：介面延遲上限 200ms。',
    tag: '沒人回答時她會補上',
  },
]

/**
 * 每段佔 9s（與 mb-q / mb-think / mb-a 的週期同步），整輪 27s。
 * 第 i 段用負延遲把自己卡進第 i 個時段——正延遲會讓開場前幾秒整片空白。
 */
const SLOT = 9
const CYCLE = SLOT * SCENES.length
const slotDelay = (i: number) =>
  ({ '--d': i ? `${i * SLOT - CYCLE}s` : '0s' }) as React.CSSProperties

/** 環繞四周的產出物標籤（純裝飾）。位置刻意避開上方的提問泡泡，只貼在吉祥物兩側。 */
const CHIPS = [
  { label: '會議記錄', className: 'right-0 top-36 sm:-right-4', delay: '0s' },
  { label: '待辦事項', className: 'right-2 top-[15rem]', delay: '1.1s' },
  { label: '會議摘要', className: 'left-0 top-40 sm:-left-6', delay: '2.2s' },
  { label: '逐字稿', className: 'left-2 top-[16.5rem]', delay: '3.3s' },
]

export function HeroScene() {
  return (
    <figure
      aria-label="示意：開會時喊一聲蜜塔就能問她，她查過專案資料後回答；追問不必再喊一次名字，沒人回答的問題她也會主動補上"
      className="relative mx-auto max-w-lg"
    >
      {/* 蜂蜜光暈 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-honey/20 blur-3xl"
      />

      {/* 漂浮標籤 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {CHIPS.map((chip) => (
          <span
            key={chip.label}
            className={`mb-drift absolute rounded-full border border-line bg-paper/90 px-3 py-1.5 text-xs font-medium text-ink-soft shadow-sm backdrop-blur-sm ${chip.className}`}
            style={{ '--d': chip.delay } as React.CSSProperties}
          >
            {chip.label}
          </span>
        ))}
      </div>

      {/* 三段對話疊在同兩格裡（grid 同格堆疊），高度取最高的一段，輪播時版面不跳 */}
      <div aria-hidden="true" className="flex flex-col items-center pt-8">
        <div className="grid w-full">
          {SCENES.map((s, i) => (
            <p
              key={s.ask}
              style={slotDelay(i)}
              className="mb-scene col-start-1 row-start-1 self-start justify-self-start"
            >
              <span className="mb-q relative z-10 inline-block rounded-2xl rounded-bl-sm border border-line bg-pollen px-4 py-3 text-sm leading-6 text-ink shadow-sm sm:ml-6">
                {s.ask}
              </span>
            </p>
          ))}
        </div>

        <Mascot pose="work" className="mb-float -mt-2 size-56 sm:size-64" />

        <div className="grid w-full">
          {SCENES.map((s, i) => (
            <div
              key={s.ask}
              style={slotDelay(i)}
              className="mb-scene col-start-1 row-start-1 flex flex-col items-center"
            >
              {/* 思考中 */}
              <p className="mb-think -mt-4 flex items-center gap-2 rounded-full border border-line bg-paper px-4 py-2 text-xs text-ink-soft shadow-sm">
                {s.thinking}
                <span className="flex gap-1">
                  <span className="size-1.5 rounded-full bg-honey" />
                  <span className="size-1.5 rounded-full bg-honey/70" />
                  <span className="size-1.5 rounded-full bg-honey/40" />
                </span>
              </p>

              {/* 答案卡 */}
              <div className="mb-a -mt-4 w-full rounded-2xl border border-line bg-paper p-4 shadow-xl shadow-ink/10 sm:p-5">
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-sm font-bold text-ink">
                    蜜塔
                  </span>
                  <span
                    translate="no"
                    className="font-mono text-xs text-ink-soft"
                  >
                    {s.at}
                  </span>
                </div>
                <p className="mt-2 text-pretty text-sm leading-6 text-ink">
                  {s.answer}
                </p>
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-pollen px-3 py-1 text-xs font-medium text-honey-deep">
                  <CheckMark />
                  {s.tag}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </figure>
  )
}

function CheckMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 8.5 3.5 3.5L13 4.5" />
    </svg>
  )
}
