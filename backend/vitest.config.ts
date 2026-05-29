import { defineConfig } from 'vitest/config'
import path from 'path'

const backendNodeModules = path.resolve(import.meta.dirname, 'node_modules')
const projectRoot = path.resolve(import.meta.dirname, '..')

export default defineConfig({
  resolve: {
    // Tell Vite to look in backend/node_modules when resolving npm packages
    // (tests live in tests/ but deps are installed in backend/node_modules)
    modules: [backendNodeModules, 'node_modules'],
  },
  test: {
    root: projectRoot,
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
})
