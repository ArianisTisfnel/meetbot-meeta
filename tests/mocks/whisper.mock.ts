import { vi } from 'vitest'

export const mockWhisper = {
  isWhisperConfigured: vi.fn().mockReturnValue(true),
  submitTranscriptionJob: vi.fn().mockResolvedValue('whisper-job-1'),
  getTranscriptionJob: vi.fn().mockResolvedValue({ status: 'processing' }),
}
