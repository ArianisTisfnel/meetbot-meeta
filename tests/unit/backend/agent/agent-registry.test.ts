import { describe, it, expect, vi, beforeEach } from 'vitest'

// registry 依賴 env（import 時驗證環境變數會 process.exit）→ mock 成可變物件，
// 各測試可直接改欄位驗證開關組合。
vi.mock('../../../../backend/src/types/env', () => ({
  env: {
    AGENT_MODE: 'on',
    AGENT_PAGE_URL: 'https://front.test/agent',
    OPENAI_API_KEY: 'sk-test',
    RECALL_WEBHOOK_URL: 'https://hook.test',
    RECALL_WEBHOOK_TOKEN: 'secret',
  },
}))

import { env } from '../../../../backend/src/types/env'
import {
  isAgentModeEnabled,
  signAgentToken,
  verifyAgentToken,
  deriveAgentWsUrl,
  buildAgentPageUrl,
  registerAgentSession,
  unregisterAgentSession,
  getAgentSession,
  getAgentSessionByBotId,
  markAgentAnchor,
  isAgentLive,
  type PageSocketLike,
} from '../../../../backend/src/agent/agent-registry'

const AGENT_ID = 'agent-uuid-1'
const BOT_ID = 'bot-abc'

/** 假的網頁 WS 連線（registry 只看 readyState/OPEN）。 */
function fakePageWs(open = true): PageSocketLike {
  return { readyState: open ? 1 : 3, OPEN: 1, send: vi.fn(), close: vi.fn() }
}

beforeEach(() => {
  unregisterAgentSession(AGENT_ID)
  ;(env as Record<string, unknown>).AGENT_MODE = 'on'
  ;(env as Record<string, unknown>).AGENT_PAGE_URL = 'https://front.test/agent'
})

describe('isAgentModeEnabled', () => {
  it('開關 on 且設定齊全 → true', () => {
    expect(isAgentModeEnabled()).toBe(true)
  })

  it('AGENT_MODE=off → false（完全回退現行路徑）', () => {
    ;(env as Record<string, unknown>).AGENT_MODE = 'off'
    expect(isAgentModeEnabled()).toBe(false)
  })

  it('缺 AGENT_PAGE_URL → false（開了開關也不啟用）', () => {
    ;(env as Record<string, unknown>).AGENT_PAGE_URL = undefined
    expect(isAgentModeEnabled()).toBe(false)
  })
})

describe('token 簽名與驗證', () => {
  it('同 agentId 簽名穩定；驗證通過', () => {
    const token = signAgentToken(AGENT_ID)
    expect(token).toBe(signAgentToken(AGENT_ID))
    expect(verifyAgentToken(AGENT_ID, token)).toBe(true)
  })

  it('錯誤 token / 長度不符 → 驗證失敗且不丟錯', () => {
    expect(verifyAgentToken(AGENT_ID, 'wrong')).toBe(false)
    expect(verifyAgentToken(AGENT_ID, signAgentToken('other-agent'))).toBe(false)
  })
})

describe('URL 組裝', () => {
  it('deriveAgentWsUrl：https→wss、帶 agent 與 token', () => {
    const url = deriveAgentWsUrl(AGENT_ID)
    expect(url).toBe(`wss://hook.test/ws/agent?agent=${AGENT_ID}&token=${signAgentToken(AGENT_ID)}`)
  })

  it('buildAgentPageUrl：agent 網頁 URL 帶 encode 過的 ws 參數', () => {
    const url = buildAgentPageUrl(AGENT_ID)
    expect(url.startsWith('https://front.test/agent?ws=')).toBe(true)
    const ws = new URL(url).searchParams.get('ws')
    expect(ws).toBe(deriveAgentWsUrl(AGENT_ID))
  })
})

describe('registry', () => {
  it('register → 可依 agentId 與 botId 找回；unregister → 兩個索引都清掉', () => {
    registerAgentSession(AGENT_ID, BOT_ID, '蜜塔', {})
    expect(getAgentSession(AGENT_ID)?.botId).toBe(BOT_ID)
    expect(getAgentSessionByBotId(BOT_ID)?.agentId).toBe(AGENT_ID)

    unregisterAgentSession(AGENT_ID)
    expect(getAgentSession(AGENT_ID)).toBeUndefined()
    expect(getAgentSessionByBotId(BOT_ID)).toBeUndefined()
  })

  it('isAgentLive：未註冊 / 無網頁連線 / 連線關閉 → false；連線開啟 → true', () => {
    expect(isAgentLive(BOT_ID)).toBe(false)

    const session = registerAgentSession(AGENT_ID, BOT_ID, '蜜塔', {})
    expect(isAgentLive(BOT_ID)).toBe(false)

    session.pageWs = fakePageWs(true)
    expect(isAgentLive(BOT_ID)).toBe(true)

    session.pageWs = fakePageWs(false)
    expect(isAgentLive(BOT_ID)).toBe(false)
  })

  it('markAgentAnchor：更新時間錨點（admitted 時對齊 sessionStartedAt）', () => {
    const session = registerAgentSession(AGENT_ID, BOT_ID, '蜜塔', {})
    session.anchorMs = 123
    markAgentAnchor(AGENT_ID)
    expect(session.anchorMs).toBeGreaterThan(123)
  })
})
