import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'domain/index': 'src/domain/index.ts',
    'ports/index': 'src/ports/index.ts',
    'application/index': 'src/application/index.ts',
    'infrastructure/index': 'src/infrastructure/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: false,
})
