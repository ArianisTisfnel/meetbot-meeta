import { describe, it, expect, beforeEach, vi } from 'vitest'

// logger → env（env 驗證失敗會 process.exit），與其他 session 測試同一套隔離手法
vi.mock('../../../../backend/src/types/env', () => ({ env: {} }))
vi.mock('../../../../backend/src/middleware/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  recordSpeechOn,
  recordSpeechOff,
  resolveSpeakerAt,
  clearSpeakerTimeline,
  SPEAKER_LOOKBACK_MS,
  _peekTimeline,
} from '../../../../backend/src/agent/speaker-timeline'

const BOT = 'bot-1'
const T0 = 1_700_000_000_000

beforeEach(() => clearSpeakerTimeline(BOT))

describe('speaker-timeline — 基本歸屬', () => {
  it('單一講者講完 → 定稿時回看窗內查得到（點查詢會落空的情境）', () => {
    // 小明 T0 開口、T0+4s 停口；轉錄定稿延遲 2 秒才到 → 查詢時刻 T0+6s
    // 此刻小明已 speech_off，點查詢查不到人，回看窗才查得到
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOff(BOT, '小明', T0 + 4_000)
    expect(resolveSpeakerAt(BOT, T0 + 6_000)).toBe('小明')
  })

  it('還在講（speech_off 未到）→ 算到查詢時刻為止', () => {
    recordSpeechOn(BOT, '小華', T0)
    expect(resolveSpeakerAt(BOT, T0 + 3_000)).toBe('小華')
  })

  it('無任何事件 → null（維持改動前的未知講者行為）', () => {
    expect(resolveSpeakerAt(BOT, T0)).toBeNull()
  })

  it('講話時間早於回看窗 → null，不亂掛給很久以前的人', () => {
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOff(BOT, '小明', T0 + 2_000)
    expect(resolveSpeakerAt(BOT, T0 + SPEAKER_LOOKBACK_MS + 5_000)).toBeNull()
  })
})

describe('speaker-timeline — 多人', () => {
  it('前後兩人接力 → 歸給窗內講較久的那位', () => {
    // 小明講 1 秒後停；小華接著講 8 秒 → 定稿歸小華
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOff(BOT, '小明', T0 + 1_000)
    recordSpeechOn(BOT, '小華', T0 + 1_500)
    recordSpeechOff(BOT, '小華', T0 + 9_500)
    expect(resolveSpeakerAt(BOT, T0 + 10_000)).toBe('小華')
  })

  it('兩人同時發言且時長相近 → null（寧可不標，不可標錯人）', () => {
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOn(BOT, '小華', T0 + 200)
    recordSpeechOff(BOT, '小明', T0 + 5_000)
    recordSpeechOff(BOT, '小華', T0 + 5_000)
    expect(resolveSpeakerAt(BOT, T0 + 6_000)).toBeNull()
  })

  it('同一人講講停停 → 多段加總後仍勝過插嘴一句的人', () => {
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOff(BOT, '小明', T0 + 3_000)
    recordSpeechOn(BOT, '小華', T0 + 3_100) // 插嘴 0.5 秒
    recordSpeechOff(BOT, '小華', T0 + 3_600)
    recordSpeechOn(BOT, '小明', T0 + 4_000)
    recordSpeechOff(BOT, '小明', T0 + 7_000)
    expect(resolveSpeakerAt(BOT, T0 + 8_000)).toBe('小明')
  })
})

describe('speaker-timeline — 事件不完整時的韌性', () => {
  it('重複 speech_on 沒有 off → 不開重複區間（否則重疊被重複計數）', () => {
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOn(BOT, '小明', T0 + 500)
    recordSpeechOn(BOT, '小明', T0 + 900)
    expect(_peekTimeline(BOT).filter((i) => i.endMs === null)).toHaveLength(1)
  })

  it('speech_off 沒有對應的 on → 安靜忽略，不炸也不建區間', () => {
    expect(() => recordSpeechOff(BOT, '幽靈', T0)).not.toThrow()
    expect(_peekTimeline(BOT)).toHaveLength(0)
  })

  it('空名字一律忽略（Recall 偶爾送不出 participant.name）', () => {
    recordSpeechOn(BOT, '', T0)
    expect(_peekTimeline(BOT)).toHaveLength(0)
    expect(resolveSpeakerAt(BOT, T0 + 1_000)).toBeNull()
  })

  it('clearSpeakerTimeline 之後查不到（session 結束不可殘留跨會議狀態）', () => {
    recordSpeechOn(BOT, '小明', T0)
    clearSpeakerTimeline(BOT)
    expect(resolveSpeakerAt(BOT, T0 + 1_000)).toBeNull()
  })

  it('不同 bot 的時間軸互不干擾（單進程同時多場會議）', () => {
    recordSpeechOn(BOT, '小明', T0)
    recordSpeechOn('bot-2', '小華', T0)
    expect(resolveSpeakerAt(BOT, T0 + 1_000)).toBe('小明')
    expect(resolveSpeakerAt('bot-2', T0 + 1_000)).toBe('小華')
    clearSpeakerTimeline('bot-2')
  })
})
