import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'template/index': 'src/template/index.ts',
    'printdata/index': 'src/printdata/index.ts',
    'layout/index': 'src/layout/index.ts',
    'printer/index': 'src/printer/index.ts',
    'printing/index': 'src/printing/index.ts',
    'ports/index': 'src/ports/index.ts',
    'application/index': 'src/application/index.ts',
    'infrastructure/index': 'src/infrastructure/index.ts',
    'browser/index': 'src/browser/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
})
