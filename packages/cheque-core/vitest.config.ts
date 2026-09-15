import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Deliberately 'node': the domain core must not require a DOM.
    // If a test here ever needs jsdom, a DOM dependency has leaked into the domain.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
