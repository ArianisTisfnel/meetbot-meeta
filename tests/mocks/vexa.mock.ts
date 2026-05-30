import { vi } from 'vitest'

export const mockVexa = {
  parseGoogleMeetUrl: vi.fn().mockImplementation((url: string) => {
    const m = url.match(
      /meet\.google\.com\/((?:[a-z]{3}-[a-z]{4}-[a-z]{3})|(?:[a-z0-9][a-z0-9-]{3,38}[a-z0-9]))/,
    )
    return m ? m[1] : null
  }),
  inviteBot: vi.fn().mockResolvedValue({ vexaMeetingId: 42, nativeMeetingId: 'abc-defg-hij' }),
  removeBot: vi.fn().mockResolvedValue(undefined),
  getTranscriptions: vi.fn().mockResolvedValue([]),
  speak: vi.fn().mockResolvedValue(undefined),
  chatSend: vi.fn().mockResolvedValue(undefined),
  VexaConcurrentLimitError: class VexaConcurrentLimitError extends Error {
    constructor() {
      super('Vexa: maximum concurrent bot limit reached')
      this.name = 'VexaConcurrentLimitError'
    }
  },
}
