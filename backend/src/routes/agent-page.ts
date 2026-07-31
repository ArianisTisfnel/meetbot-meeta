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
 *   上行 binary = PCM16 24kHz mono 會議音訊；下行 binary = 蜜塔語音；{type:'stop'} = 立停
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
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2rem;
    background: radial-gradient(ellipse at center, #3a2d14 0%, #1c1509 55%, #120d05 100%);
    font-family: 'Noto Sans TC', 'Microsoft JhengHei', sans-serif;
    overflow: hidden;
  }
  .stage { position: relative; display: flex; align-items: center; justify-content: center; }
  .glow {
    position: absolute; width: 12rem; height: 12rem; border-radius: 50%;
    background: rgba(251, 191, 36, 0.25); filter: blur(24px);
    opacity: 0.3; transition: opacity 0.5s;
  }
  .ring {
    position: absolute; width: 14rem; height: 14rem; border-radius: 50%;
    background: rgba(251, 191, 36, 0.2); display: none;
  }
  .avatar {
    position: relative; width: 10rem; height: 10rem; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #fcd34d, #fbbf24, #ca8a04);
    box-shadow: 0 0 60px rgba(251, 191, 36, 0.35);
    font-size: 3rem; font-weight: 700; color: #451a03; user-select: none;
    transition: transform 0.3s;
  }
  .status { font-size: 1.5rem; font-weight: 500; letter-spacing: 0.05em; color: #fef3c7; text-align: center; }
  .sub { display: flex; align-items: center; gap: 0.5rem; justify-content: center;
         font-size: 0.875rem; color: rgba(253, 230, 138, 0.6); margin-top: 0.5rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #fde047; }
  @keyframes ping { 75%, 100% { transform: scale(1.6); opacity: 0; } }
  @keyframes pulse { 50% { opacity: 0.7; } }
  body.listening .glow { opacity: 1; }
  body.listening .dot { background: #34d399; }
  body.speaking .glow { opacity: 1; }
  body.speaking .ring { display: block; animation: ping 1.2s cubic-bezier(0,0,0.2,1) infinite; }
  body.speaking .avatar { transform: scale(1.05); animation: pulse 1.5s ease-in-out infinite; }
  body.speaking .dot { background: #34d399; }
  body.connecting .dot { animation: pulse 1.2s ease-in-out infinite; }
  body.error .dot { background: #f87171; }
</style>
</head>
<body class="connecting">
  <div class="stage">
    <span class="ring"></span>
    <span class="glow"></span>
    <div class="avatar">蜜塔</div>
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
  // 收音由伺服器（relay）指揮開關：它才知道語音真正播完的時刻。
  // 這個上限只是保命——指令掉了也不會永久失聰。
  const MAX_MUTE_MS = 30000
  const MUTE_WATCHDOG_MS = 5000

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
  constructor() {
    super()
    this.queue = []; this.offset = 0; this.buffered = 0
    this.started = false; this.forceStart = false; this.playing = false
    this.PREBUFFER = 12000 // 24kHz × 0.5s
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = []; this.offset = 0; this.buffered = 0
        this.started = false; this.forceStart = false
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
    if (!this.started) {
      if (this.buffered >= this.PREBUFFER || (this.forceStart && this.buffered > 0)) {
        this.started = true
      } else {
        for (let i = 0; i < out.length; i++) out[i] = 0
        this.report(false)
        return true
      }
    }
    let i = 0
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0]
      out[i++] = chunk[this.offset++] / 0x8000
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
  let captureEnabled = true
  let mutedAt = 0
  let wsOpen = false
  const refreshState = () => setState(playing ? 'speaking' : wsOpen ? 'listening' : 'connecting')
  const setCapture = (enabled) => {
    captureEnabled = enabled
    mutedAt = enabled ? 0 : Date.now()
  }
  // 保命閥：靜音指令的解除訊息掉了（WS 抖動/伺服器重啟）也要自己醒過來
  setInterval(() => {
    if (!captureEnabled && mutedAt && Date.now() - mutedAt > MAX_MUTE_MS) setCapture(true)
  }, MUTE_WATCHDOG_MS)

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
    // 播放狀態只用來更新畫面：不能拿它來解除靜音——串流塊到得慢時佇列會中途播空
    // （report(false)），那時蜜塔其實還沒講完，提早開麥就會把自己的聲音錄進去。
    player.port.onmessage = (e) => { playing = Boolean(e.data && e.data.playing); refreshState() }

    // 靜音時送等長的靜音塊，而不是停止上傳：轉錄端靠連續音訊流判斷句子結束，
    // 中間斷流會讓使用者正在問的那句遲遲不定稿（問了卻沒反應）。
    const silence = new Int16Array(CAPTURE_CHUNK_SAMPLES)
    capture.port.onmessage = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(captureEnabled ? e.data.buffer : silence.buffer)
    }

    const connect = () => {
      ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { wsOpen = true; refreshState() }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const message = JSON.parse(ev.data)
            if (message.type === 'input-mute') setCapture(!message.muted)
            else if (message.type === 'stop') player.port.postMessage('clear')
            else if (message.type === 'flush') player.port.postMessage('flush')
          } catch {}
          return
        }
        player.port.postMessage(new Int16Array(ev.data))
      }
      ws.onclose = () => {
        wsOpen = false
        player.port.postMessage('clear')
        setCapture(true) // 連線斷了就沒人會來解靜音，重連後要聽得見
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
