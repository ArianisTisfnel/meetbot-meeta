'use client'

/**
 * Agent 網頁 — Recall bot 的 Output Media 頁（方案 A 的「耳朵和嘴巴」）。
 *
 * 這一頁跑在 Recall bot 的雲端瀏覽器裡：
 *   - 畫面 ＝ 蜜塔在會議中的視訊格（1280×720 / 15fps）
 *   - getUserMedia 拿到的「麥克風」＝ 會議即時混音（Recall 自動授權，毫秒級）
 *   - 頁面播的聲音 ＝ 蜜塔在會議中的語音
 *
 * 音訊協定（對 backend /ws/agent，URL 由 ?ws= 查詢參數帶入，含 agentId＋簽名 token）：
 *   上行 binary ＝ PCM16 24kHz mono 會議音訊（100ms 一塊）
 *   下行 binary ＝ PCM16 24kHz mono 蜜塔語音（邊收邊播）
 *   下行 JSON {type:'stop'} ＝ barge-in 讓路，立刻清空播放佇列
 *
 * 免登入：此頁不在 (app)/(auth) route group 內，bot 瀏覽器可直接開啟。
 * WS 斷線自動重連（backend 心跳超時會終止殭屍連線，重連後耳朵嘴巴恢復）。
 */

import { useEffect, useRef, useState } from 'react'

type AgentState = 'connecting' | 'listening' | 'speaking' | 'error'

const STATE_LABEL: Record<AgentState, string> = {
  connecting: '連線中…',
  listening: '我在聽，叫「蜜塔」就能提問',
  speaking: '回答中',
  error: '連線設定有誤',
}

const RECONNECT_DELAY_MS = 2000
/** 24kHz × 100ms = 2400 samples／塊。 */
const CAPTURE_CHUNK_SAMPLES = 2400

/**
 * AudioWorklet（收音＋播放）以 Blob URL 載入，頁面自包含、零依賴。
 * pcm-capture：Float32 → Int16，湊滿一塊 postMessage 回主執行緒。
 * pcm-player ：主執行緒餵 Int16Array 佇列，'clear' 立停；佇列空/非空時回報 playing 狀態。
 */
const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(${CAPTURE_CHUNK_SAMPLES})
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.playing = false
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = []
        this.offset = 0
      } else {
        this.queue.push(e.data)
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    if (!out) return true
    let i = 0
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0]
      out[i++] = chunk[this.offset++] / 0x8000
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    for (; i < out.length; i++) out[i] = 0
    const playing = this.queue.length > 0
    if (playing !== this.playing) {
      this.playing = playing
      this.port.postMessage({ playing })
    }
    return true
  }
}
registerProcessor('pcm-player', PcmPlayer)
`

export default function AgentPage() {
  const [state, setState] = useState<AgentState>('connecting')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const wsUrl = new URLSearchParams(window.location.search).get('ws')
    if (!wsUrl) {
      setState('error')
      return
    }

    let ws: WebSocket | null = null
    let disposed = false
    // 播放中以 player 回報為準；沒在播時依 WS 開閉顯示 listening / connecting
    let playing = false
    let wsOpen = false
    const refreshState = () => {
      if (disposed) return
      setState(playing ? 'speaking' : wsOpen ? 'listening' : 'connecting')
    }

    const start = async () => {
      // Recall bot 瀏覽器帶 autoplay 權限；resume 保險（一般瀏覽器手動測試時需要）
      const ctx = new AudioContext({ sampleRate: 24000 })
      void ctx.resume()

      const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
      await ctx.audioWorklet.addModule(workletUrl)
      URL.revokeObjectURL(workletUrl)

      // 「麥克風」＝會議混音。echoCancellation 防蜜塔自己的聲音殘留造成自迴圈。
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
      const source = ctx.createMediaStreamSource(mic)
      const capture = new AudioWorkletNode(ctx, 'pcm-capture')
      source.connect(capture)

      const player = new AudioWorkletNode(ctx, 'pcm-player')
      player.connect(ctx.destination)
      player.port.onmessage = (e: MessageEvent) => {
        playing = Boolean(e.data?.playing)
        refreshState()
      }

      capture.port.onmessage = (e: MessageEvent) => {
        const pcm = e.data as Int16Array
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer)
      }

      const connect = () => {
        if (disposed) return
        ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          wsOpen = true
          refreshState()
        }
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data)
              if (msg?.type === 'stop') player.port.postMessage('clear')
            } catch {
              /* 未知訊息忽略 */
            }
            return
          }
          player.port.postMessage(new Int16Array(ev.data as ArrayBuffer))
        }
        ws.onclose = () => {
          wsOpen = false
          player.port.postMessage('clear')
          refreshState()
          if (!disposed) setTimeout(connect, RECONNECT_DELAY_MS)
        }
        ws.onerror = () => ws?.close()
      }
      connect()
    }

    start().catch((err) => {
      console.error('agent page init failed', err)
      setState('error')
    })

    return () => {
      disposed = true
      ws?.close()
    }
  }, [])

  const speaking = state === 'speaking'

  return (
    <main className="fixed inset-0 flex flex-col items-center justify-center gap-8 bg-[radial-gradient(ellipse_at_center,#3a2d14_0%,#1c1509_55%,#120d05_100%)] font-sans">
      {/* 蜜塔頭像：說話時外圈擴散、內圈脈動 */}
      <div className="relative flex items-center justify-center">
        {speaking && (
          <span className="absolute inline-flex h-56 w-56 animate-ping rounded-full bg-amber-400/20" />
        )}
        <span
          className={`absolute inline-flex h-48 w-48 rounded-full bg-amber-400/25 blur-xl transition-opacity duration-500 ${
            state === 'listening' || speaking ? 'opacity-100' : 'opacity-30'
          }`}
        />
        <div
          className={`relative flex h-40 w-40 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-yellow-600 shadow-[0_0_60px_rgba(251,191,36,0.35)] transition-transform duration-300 ${
            speaking ? 'scale-105 animate-pulse' : ''
          }`}
        >
          <span className="select-none font-display text-5xl font-bold text-amber-950">蜜塔</span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="text-2xl font-medium tracking-wide text-amber-100">
          {STATE_LABEL[state]}
        </div>
        <div className="flex items-center gap-2 text-sm text-amber-200/60">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              state === 'error'
                ? 'bg-red-400'
                : state === 'connecting'
                  ? 'bg-yellow-300 animate-pulse'
                  : 'bg-emerald-400'
            }`}
          />
          {state === 'error' ? '缺少連線參數' : speaking ? '正在回答' : '即時語音助理已就緒'}
        </div>
      </div>
    </main>
  )
}
