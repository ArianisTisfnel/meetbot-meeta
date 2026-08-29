import { Hono } from 'hono'
import type { AppEnv } from '../types/hono.js'

/**
 * Agent 網頁（後端版）— Recall bot 的 Output Media 頁，由後端直接供應。
 *
 * 為什麼由後端出而不是前端 Next.js：
 *   bot 的雲端瀏覽器要能從外網開到這一頁。ngrok 免費域名對「瀏覽器導覽」會插
 *   ERR_NGROK_6024 警告頁（request 端加 header 才能跳過，Recall 的瀏覽器加不了），
 *   所以網頁 + /ws/agent 走同一條 cloudflared quick tunnel（無警告頁）到後端 4000，
 *   單一公開網址、同源 WS，不需要第二條前端 tunnel。
 *
 * 頁面協定與 frontend/src/app/agent/page.tsx 相同（那份保留給前端公開部署時用）：
 *   查詢參數：agent + token（同源連 /ws/agent），或 ws=完整 WS URL（跨源覆蓋，手動測試用）
 *   上行 binary = PCM16 24kHz mono 會議音訊；下行 binary = 蜜塔語音；
 *   {type:'stop'} = 立停（清佇列，接不回來）；{type:'pause'}／{type:'resume'} = 暫停／從斷點接回
 *
 * 免登入：authMiddleware 放行 /agent（頁面本身無機密；WS 連線由簽名 token 把關）。
 */

const app = new Hono<AppEnv>()

const AGENT_PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蜜塔 Meeta</title>
<style>
  /* 角色規格 2026-08-17 v2（scratchpad meeta7.png 定稿）：
     蛋形奶油身＋深藍臉屏＋發光暖黃眼；夜空深藍背景讓奶油身體與發光眼跳出來。
     色票 #FFE28D（黃）#FAC1A8（桃）#13193D（深藍）。
     天線是情緒器官：睏了下垂（connecting）、平時輕搖、說話豎起。 */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.25rem;
    background: radial-gradient(ellipse at center, #232B5C 0%, #171E48 55%, #0E1333 100%);
    font-family: 'Noto Sans TC', 'Microsoft JhengHei', sans-serif;
    overflow: hidden;
  }
  .stage { position: relative; display: flex; align-items: center; justify-content: center; }
  /* 光暈不用 filter: blur()——Recall 的雲端瀏覽器 CPU 很弱，模糊濾鏡每幀重算會
     搶走主執行緒，WS 音訊塊晚進 worklet → jitter buffer 播空重積 → 語音聽起來被拖慢
     （實測回報 2026-08-17）。改用預先算好的放射漸層，視覺相同、零每幀成本。 */
  .glow {
    position: absolute; width: 17rem; height: 17rem; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(255, 226, 141, 0.35), rgba(255, 226, 141, 0.12) 55%, transparent 75%);
    opacity: 0.3; transition: opacity 0.5s;
  }
  .ring {
    position: absolute; width: 15rem; height: 15rem; border-radius: 50%;
    background: rgba(250, 193, 168, 0.3); display: none;
  }
  .character { position: relative; width: 15rem; animation: bob 3.4s ease-in-out infinite; }
  .character svg { display: block; width: 100%; height: auto; }
  /* 眨眼：整組眼睛 scaleY 壓扁再彈回 */
  .eyes { transform-origin: 120px 104px; animation: blink 4.6s infinite; transition: opacity 0.3s; }
  .eyes-sleep { opacity: 0; transition: opacity 0.3s; }
  /* 花瓣耳：待機輕搖；情緒姿態用 transition 滑過去 */
  .ear-l { transform-origin: 97px 50px; animation: sway 3.4s ease-in-out infinite; transition: transform 0.6s ease; }
  .ear-r { transform-origin: 143px 50px; animation: sway 3.4s ease-in-out infinite reverse; transition: transform 0.6s ease; }
  .zzz {
    position: absolute; top: 0.25rem; right: 1.5rem; font-weight: 700; color: #FFE28D;
    opacity: 0; transition: opacity 0.4s;
    font-size: 1.1rem; letter-spacing: 0.1em;
  }
  body.connecting .zzz { animation: floatz 2.2s ease-in-out infinite; }
  .status { font-size: 1.4rem; font-weight: 600; letter-spacing: 0.05em; color: #FEF3C7; text-align: center; }
  .sub { display: flex; align-items: center; gap: 0.5rem; justify-content: center;
         font-size: 0.875rem; color: rgba(253, 230, 138, 0.65); margin-top: 0.4rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #FFE28D; }
  @keyframes ping { 75%, 100% { transform: scale(1.5); opacity: 0; } }
  @keyframes pulse { 50% { opacity: 0.7; } }
  @keyframes bob { 50% { transform: translateY(-6px); } }
  @keyframes blink { 0%, 93%, 100% { transform: scaleY(1); } 95.5% { transform: scaleY(0.08); } }
  @keyframes sway { 50% { transform: rotate(4deg); } }
  @keyframes floatz { 0% { transform: translateY(0); opacity: 0; } 25% { opacity: 0.85; }
                      100% { transform: translateY(-14px); opacity: 0; } }
  body.listening .glow { opacity: 0.75; }
  body.listening .dot { background: #34d399; }
  body.speaking .glow { opacity: 1; }
  body.speaking .ring { display: block; animation: ping 1.2s cubic-bezier(0,0,0.2,1) infinite; }
  body.speaking .character { animation: bob 1.7s ease-in-out infinite; }
  /* 說話＝興奮：耳朵豎起 */
  body.speaking .ear-l { animation: none; transform: rotate(16deg); }
  body.speaking .ear-r { animation: none; transform: rotate(-16deg); }
  body.speaking .dot { background: #34d399; }
  /* 連線中＝打瞌睡：耳朵下垂＋⌒ 閉眼＋Zz，接上就醒 */
  body.connecting .eyes { opacity: 0; animation: none; }
  body.connecting .eyes-sleep { opacity: 1; }
  body.connecting .ear-l { animation: none; transform: rotate(-34deg); }
  body.connecting .ear-r { animation: none; transform: rotate(34deg); }
  body.connecting .zzz { opacity: 1; }
  body.connecting .dot { animation: pulse 1.2s ease-in-out infinite; }
  body.error .dot { background: #f87171; }
</style>
</head>
<body class="connecting">
  <div class="stage">
    <span class="ring"></span>
    <span class="glow"></span>
    <div class="character">
      <span class="zzz">Z z</span>
      <svg viewBox="0 0 240 220" role="img" aria-label="蜜塔">
        <defs>
          <linearGradient id="shell" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#FFF8E8"/>
            <stop offset="62%" stop-color="#FDF0DA"/>
            <stop offset="100%" stop-color="#FAE3CB"/>
          </linearGradient>
          <radialGradient id="pod" cx="0.4" cy="0.35" r="0.9">
            <stop offset="0%" stop-color="#FCD3B8"/>
            <stop offset="100%" stop-color="#F5AE8C"/>
          </radialGradient>
          <!-- 眼睛光暈用漸層不用 feGaussianBlur：眨眼動畫每幀都會重跑濾鏡（見 .glow 註解） -->
          <radialGradient id="eyeglow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stop-color="#FFE28D" stop-opacity="0.55"/>
            <stop offset="60%" stop-color="#FFE28D" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#FFE28D" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <!-- 地面暗影 -->
        <ellipse cx="120" cy="208" rx="60" ry="8" fill="#0A0F26" opacity="0.55"/>
        <!-- 花瓣耳天線：曲桿＋深藍關節＋軟花瓣（黃底桃心） -->
        <g class="ear-l">
          <path d="M 97 50 Q 92 44 90 39" stroke="#13193D" stroke-width="4" fill="none" stroke-linecap="round"/>
          <circle cx="90" cy="38" r="4.2" fill="#13193D"/>
          <path d="M 89 40 C 74 40, 60 30, 60 16 C 60 6, 71 4, 78 11 C 86 19, 91 30, 89 40 Z" fill="#FFE28D"/>
          <path d="M 72 26 C 65 21, 61 14, 63 9 C 66 4.5, 73 6.5, 77 12 C 81 18, 79 24, 72 26 Z" fill="#FAC1A8"/>
        </g>
        <g class="ear-r">
          <path d="M 143 50 Q 148 44 150 39" stroke="#13193D" stroke-width="4" fill="none" stroke-linecap="round"/>
          <circle cx="150" cy="38" r="4.2" fill="#13193D"/>
          <path d="M 151 40 C 166 40, 180 30, 180 16 C 180 6, 169 4, 162 11 C 154 19, 149 30, 151 40 Z" fill="#FFE28D"/>
          <path d="M 168 26 C 175 21, 179 14, 177 9 C 174 4.5, 167 6.5, 163 12 C 159 18, 161 24, 168 26 Z" fill="#FAC1A8"/>
        </g>
        <!-- 腳：小小的深藍圓 -->
        <ellipse cx="101" cy="203" rx="12" ry="8.5" fill="#13193D"/>
        <ellipse cx="139" cy="203" rx="12" ry="8.5" fill="#13193D"/>
        <!-- 身體：蛋形（下緣稍平），奶油微漸層，無硬描邊 -->
        <path d="M 120 48 C 74 48, 40 82, 40 128 C 40 170, 74 200, 120 200 C 166 200, 200 170, 200 128 C 200 82, 166 48, 120 48 Z"
              fill="url(#shell)"/>
        <!-- 臉屏：大深藍橢圓＋頂緣細月牙玻璃光 -->
        <ellipse cx="120" cy="112" rx="57" ry="50" fill="#13193D"/>
        <path d="M 86 82 Q 120 68 154 82 Q 120 74 86 82 Z" fill="#39426F" opacity="0.6"/>
        <!-- 耳機模組：奶油外圈＋桃色漸層心；m 標誌只在右耳（規格） -->
        <g>
          <circle cx="38" cy="122" r="23" fill="#FBF0DC"/>
          <circle cx="38" cy="122" r="17" fill="url(#pod)"/>
        </g>
        <g>
          <circle cx="202" cy="122" r="23" fill="#FBF0DC"/>
          <circle cx="202" cy="122" r="17" fill="url(#pod)"/>
          <text x="202" y="128.5" text-anchor="middle" font-size="17" font-weight="700" fill="#FFFDF6" font-family="Arial, sans-serif">m</text>
        </g>
        <!-- 眼睛：發光暖黃橢圓（blur 光暈墊底＋實心） -->
        <g class="eyes">
          <ellipse cx="99" cy="104" rx="12" ry="16" fill="url(#eyeglow)"/>
          <ellipse cx="141" cy="104" rx="12" ry="16" fill="url(#eyeglow)"/>
          <ellipse cx="99" cy="104" rx="6.5" ry="10" fill="#FFE28D"/>
          <ellipse cx="141" cy="104" rx="6.5" ry="10" fill="#FFE28D"/>
        </g>
        <!-- 閉眼（打瞌睡）：發光 ⌒ -->
        <g class="eyes-sleep">
          <path d="M 91 104 Q 99 110 107 104" stroke="#FFE28D" stroke-width="3.4" fill="none" stroke-linecap="round" opacity="0.85"/>
          <path d="M 133 104 Q 141 110 149 104" stroke="#FFE28D" stroke-width="3.4" fill="none" stroke-linecap="round" opacity="0.85"/>
        </g>
        <!-- 嘴：發光 ◡（待機）與開口（說話，ry 由音量驅動） -->
        <path id="mouth-smile" d="M 113 122 Q 120 128 127 122"
              stroke="#FFE28D" stroke-width="3.2" fill="none" stroke-linecap="round"/>
        <ellipse id="mouth-open" cx="120" cy="124" rx="8" ry="2" fill="#FFE28D" opacity="0"/>
        <!-- 腮紅 -->
        <ellipse cx="85" cy="119" rx="7.5" ry="5.5" fill="#F9B8A0" opacity="0.9"/>
        <ellipse cx="155" cy="119" rx="7.5" ry="5.5" fill="#F9B8A0" opacity="0.9"/>
        <!-- 夜空小星 -->
        <path d="M 24 60 L 26.4 66 L 32 68 L 26.4 70 L 24 76 L 21.6 70 L 16 68 L 21.6 66 Z" fill="#FFE28D" opacity="0.7"/>
        <path d="M 219 44 L 220.8 48.4 L 225 50 L 220.8 51.6 L 219 56 L 217.2 51.6 L 213 50 L 217.2 48.4 Z" fill="#FFE28D" opacity="0.5"/>
        <circle cx="206" cy="84" r="1.6" fill="#FAC1A8" opacity="0.6"/>
        <circle cx="34" cy="96" r="1.4" fill="#FAC1A8" opacity="0.5"/>
      </svg>
    </div>
  </div>
  <div>
    <div class="status" id="status">連線中…</div>
    <div class="sub"><span class="dot"></span><span id="sub">即時語音助理啟動中</span></div>
  </div>
<script>
(() => {
  const LABEL = {
    connecting: ['連線中…', '即時語音助理啟動中'],
    listening: ['我在聽，叫「蜜塔」就能提問', '即時語音助理已就緒'],
    speaking: ['回答中', '正在回答'],
    error: ['連線設定有誤', '缺少連線參數'],
  }
  const setState = (s) => {
    document.body.className = s
    document.getElementById('status').textContent = LABEL[s][0]
    document.getElementById('sub').textContent = LABEL[s][1]
  }

  // 24kHz、100ms 一塊
  const CAPTURE_CHUNK_SAMPLES = 2400
  const RECONNECT_DELAY_MS = 2000

  const WORKLET_CODE = \`
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${'${CAPTURE_CHUNK_SAMPLES}'}); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)

class PcmPlayer extends AudioWorkletProcessor {
  // Jitter buffer：串流塊到達時間不均勻（OpenAI→relay→tunnel），到一塊播一塊會在
  // 佇列空檔靜音、下一塊再響（斷斷續續）。先積 PREBUFFER 才開播；佇列播空就重新積。
  // 'flush' = 這一句的串流已結束 → 剩多少播多少，短句不用等積滿。
  // 'pause'/'resume' = 讓路的「延後定案」：偵測到重疊語音先靜音但**保留佇列**，
  // 兩秒內對方沒有真的講下去就從斷點接回去（見 wake-word-detector 的 pendingBargeIn）。
  // 與 'clear' 的差別就是佇列留不留——清掉了就再也接不回來。
  // 進出都走 20ms 淡入淡出：硬切難聽的其實常常是 DAC 上的爆音，不是「停太快」。
  constructor() {
    super()
    this.queue = []; this.offset = 0; this.buffered = 0
    this.started = false; this.forceStart = false; this.playing = false
    this.PREBUFFER = 12000 // 24kHz × 0.5s
    this.paused = false
    this.gain = 1
    this.FADE = 1 / 480 // 每個 sample 的增益變化量：24kHz × 0.02s = 480 samples
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = []; this.offset = 0; this.buffered = 0
        this.started = false; this.forceStart = false
        this.paused = false; this.gain = 1
      } else if (e.data === 'pause') {
        this.paused = true
      } else if (e.data === 'resume') {
        this.paused = false
      } else if (e.data === 'flush') {
        this.forceStart = true
      } else {
        this.queue.push(e.data); this.buffered += e.data.length
      }
    }
  }
  report(playing) {
    if (playing !== this.playing) { this.playing = playing; this.port.postMessage({ playing }) }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    // 暫停且已淡出完畢 → 出靜音，**不動佇列**（這就是等一下能接回去的原因）。
    // 還在淡出的那 20ms 照常消耗佇列，損失聽不出來，但避免爆音。
    if (this.paused && this.gain <= 0) {
      for (let i = 0; i < out.length; i++) out[i] = 0
      this.report(false)
      return true
    }
    if (!this.started) {
      if (this.buffered >= this.PREBUFFER || (this.forceStart && this.buffered > 0)) {
        this.started = true
      } else {
        for (let i = 0; i < out.length; i++) out[i] = 0
        this.report(false)
        return true
      }
    }
    const target = this.paused ? 0 : 1
    let i = 0
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0]
      if (this.gain < target) this.gain = Math.min(target, this.gain + this.FADE)
      else if (this.gain > target) this.gain = Math.max(target, this.gain - this.FADE)
      out[i++] = (chunk[this.offset++] / 0x8000) * this.gain
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0 }
    }
    this.buffered -= i
    for (; i < out.length; i++) out[i] = 0
    if (this.queue.length === 0) { this.started = false; this.forceStart = false } // 播完，下一句重新積
    this.report(this.started || this.queue.length > 0)
    return true
  }
}
registerProcessor('pcm-player', PcmPlayer)
\`

  const params = new URLSearchParams(location.search)
  // ws=完整 WS URL（跨源覆蓋）優先；否則用 agent+token 連同源 /ws/agent
  let wsUrl = params.get('ws')
  if (!wsUrl) {
    const agent = params.get('agent')
    const token = params.get('token')
    if (agent && token) {
      wsUrl = location.origin.replace(/^http/, 'ws') +
        '/ws/agent?agent=' + encodeURIComponent(agent) + '&token=' + encodeURIComponent(token)
    }
  }
  if (!wsUrl) { setState('error'); return }

  let ws = null
  let playing = false
  let wsOpen = false
  const refreshState = () => setState(playing ? 'speaking' : wsOpen ? 'listening' : 'connecting')

  const start = async () => {
    const ctx = new AudioContext({ sampleRate: 24000 })
    void ctx.resume()
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(workletUrl)
    URL.revokeObjectURL(workletUrl)

    // 「麥克風」＝會議混音（Recall 自動授權），不是真的麥克風——
    // noiseSuppression/AGC 會把乾淨的會議音訊處理出雜音與音量泵動，弄髒轉錄 → 關閉；
    // echoCancellation 保留（防蜜塔自己的聲音殘留造成自迴圈，代價低）。
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    })
    const source = ctx.createMediaStreamSource(mic)
    const capture = new AudioWorkletNode(ctx, 'pcm-capture')
    source.connect(capture)

    const player = new AudioWorkletNode(ctx, 'pcm-player')
    player.connect(ctx.destination)
    player.port.onmessage = (e) => {
      playing = Boolean(e.data && e.data.playing)
      refreshState()
      if (playing) armMouth()
    }

    // 嘴型同步：AnalyserNode 讀 TTS 播放的實際振幅（RMS）驅動開口大小。
    // 不是「說話狀態就隨便動嘴」——講到重音嘴張大、停頓就閉上，跟聲音真的對得上。
    // 迴圈**只在播放時運轉**且節流到 ~30ms 一次：60fps 常駐迴圈在 Recall 的弱 CPU 上
    // 會跟音訊搶主執行緒（見 .glow 的註解），嘴型 30fps 肉眼無差。
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    player.connect(analyser)
    const timeData = new Uint8Array(analyser.fftSize)
    const mouthOpen = document.getElementById('mouth-open')
    const mouthSmile = document.getElementById('mouth-smile')
    let mouthLevel = 0
    let mouthRafOn = false
    let lastMouthAt = 0
    const closeMouth = () => {
      mouthLevel = 0
      mouthOpen.style.opacity = '0'
      mouthSmile.style.opacity = '1'
    }
    const animateMouth = (ts) => {
      if (!playing) { mouthRafOn = false; closeMouth(); return }
      if (ts - lastMouthAt >= 30) {
        lastMouthAt = ts
        analyser.getByteTimeDomainData(timeData)
        let sum = 0
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / timeData.length)
        // 平滑（低通）：避免逐次抖動；乘 6 把一般語音 RMS (~0.05-0.15) 拉到 0-1
        mouthLevel += (Math.min(1, rms * 6) - mouthLevel) * 0.35
        mouthOpen.setAttribute('ry', String(2 + mouthLevel * 9))
        mouthOpen.setAttribute('rx', String(7 + mouthLevel * 3))
        const talking = mouthLevel > 0.06
        mouthOpen.style.opacity = talking ? '1' : '0'
        mouthSmile.style.opacity = talking ? '0' : '1'
      }
      requestAnimationFrame(animateMouth)
    }
    const armMouth = () => {
      if (mouthRafOn) return
      mouthRafOn = true
      requestAnimationFrame(animateMouth)
    }

    capture.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer)
    }

    const connect = () => {
      ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { wsOpen = true; refreshState() }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const type = JSON.parse(ev.data).type
            if (type === 'stop') player.port.postMessage('clear')
            else if (type === 'pause') player.port.postMessage('pause')
            else if (type === 'resume') player.port.postMessage('resume')
            else if (type === 'flush') player.port.postMessage('flush')
          } catch {}
          return
        }
        player.port.postMessage(new Int16Array(ev.data))
      }
      ws.onclose = () => {
        wsOpen = false
        player.port.postMessage('clear')
        refreshState()
        setTimeout(connect, RECONNECT_DELAY_MS)
      }
      ws.onerror = () => ws && ws.close()
    }
    connect()
  }

  start().catch((err) => { console.error('agent page init failed', err); setState('error') })
})()
</script>
</body>
</html>
`

app.get('/agent', (c) => c.html(AGENT_PAGE_HTML))

export default app
