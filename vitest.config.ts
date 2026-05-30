import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    globals: true,
    environmentMatchGlobs: [
      ['tests/unit/frontend/**', 'jsdom'],
    ],
    setupFiles: ['tests/unit/frontend/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './frontend/src'),
      // Mock Next.js / next-auth modules not available in test environment
      'next-auth/react': path.resolve(
        __dirname,
        'tests/unit/frontend/__mocks__/next-auth-react.ts'
      ),
      'next/font/google': path.resolve(
        __dirname,
        'tests/unit/frontend/__mocks__/next-font-google.ts'
      ),
      'next/navigation': path.resolve(
        __dirname,
        'tests/unit/frontend/__mocks__/next-navigation.ts'
      ),
    },
  },
})
