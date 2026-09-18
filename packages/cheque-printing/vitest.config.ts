import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Deliberately 'node': the template, geometry, layout and print-output logic must not
    // require a DOM. The only DOM-touching file in the package is the isolated print
    // transport under src/browser/, which has no unit tests by design (it is exercised by
    // the app-level component tests). If a test here ever needs jsdom, DOM has leaked.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
