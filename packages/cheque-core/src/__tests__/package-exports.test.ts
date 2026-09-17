import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Package export regression test.
 *
 * The exports map in package.json is a *contract with external consumers*, but nothing in
 * `vitest run` normally exercises it: the rest of this suite imports TypeScript source, so
 * a broken exports map (a declared target tsup never emits, a wrong ESM/CJS extension) ships
 * green. That is exactly what happened: the map once declared `import: ./dist/index.mjs`
 * while tsup — with `"type": "module"` and `format: ['cjs', 'esm']` — emits
 * `dist/*.js` (ESM) and `dist/*.cjs` (CJS). Every external import resolved to a
 * nonexistent `.mjs` file and failed with ERR_MODULE_NOT_FOUND.
 *
 * These tests consume the package the way an external consumer would — by resolving the
 * package NAME through its own exports map (Node self-reference resolution) against the
 * BUILT artifacts — and are therefore only meaningful after `pnpm build`. The root test
 * script builds this package first; standalone runs must do the same:
 *
 *     pnpm --filter @printchecks/cheque-core build && pnpm --filter @printchecks/cheque-core test
 */

// src/__tests__/package-exports.test.ts -> package root
const PKG_ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

const PKG_NAME = '@printchecks/cheque-core'

interface PkgJson {
  main?: string
  module?: string
  types?: string
  exports: Record<string, unknown>
}

function readPkgJson(): PkgJson {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as PkgJson
}

/**
 * Flatten the exports map into (subpath, condition, target) triples. Top-level keys are
 * subpaths; condition objects may nest (e.g. `{"node": {"import": "..."}}`).
 */
function collectExportTargets(
  exportsMap: Record<string, unknown>,
): Array<{ subpath: string; condition: string; target: string }> {
  const out: Array<{ subpath: string; condition: string; target: string }> = []

  const walk = (value: unknown, subpath: string, condition: string): void => {
    if (typeof value === 'string') {
      out.push({ subpath, condition: condition || '(default)', target: value })
    } else if (Array.isArray(value)) {
      for (const entry of value) walk(entry, subpath, condition)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(nested, subpath, condition ? `${condition}.${key}` : key)
      }
    }
  }

  for (const [subpath, value] of Object.entries(exportsMap)) {
    walk(value, subpath, '')
  }
  return out
}

/** Named values each subpath must expose at runtime for the artifacts to count as usable. */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  '.': ['Cheque', 'ChequeCore', 'CryptoIdGenerator'],
  './domain': ['Cheque', 'ChequeNumber', 'Money'],
  './ports': ['FixedClock', 'SystemClock'],
  './application': ['ChequeCore', 'IssueChequeUseCase', 'TRANSACTIONALITY'],
  './infrastructure': ['CryptoIdGenerator', 'ChequePersistence', 'InMemoryRecordStore'],
}

const SUBPATHS = Object.keys(EXPECTED_EXPORTS)

function runNode(mode: 'import' | 'require', subpath: string): { status: number; output: string } {
  const expected = JSON.stringify(EXPECTED_EXPORTS[subpath] ?? [])
  const specifier = JSON.stringify(subpath === '.' ? PKG_NAME : `${PKG_NAME}${subpath.slice(1)}`)
  const script =
    mode === 'import'
      ? `const mod = await import(${specifier});
const missing = ${expected}.filter((name) => mod[name] === undefined);
if (missing.length > 0) { console.error('missing named exports: ' + missing.join(', ')); process.exit(1); }`
      : `const mod = require(${specifier});
const missing = ${expected}.filter((name) => mod[name] === undefined);
if (missing.length > 0) { console.error('missing named exports: ' + missing.join(', ')); process.exit(1); }`

  const result = spawnSync(
    process.execPath,
    mode === 'import' ? ['--input-type=module', '--eval', script] : ['--eval', script],
    { cwd: PKG_ROOT, encoding: 'utf8' },
  )

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { status: result.status ?? 1, output }
}

describe('package exports map', () => {
  it('declares exactly the intended public subpaths', () => {
    const pkg = readPkgJson()
    expect(Object.keys(pkg.exports).sort()).toEqual(
      ['.', './application', './domain', './infrastructure', './ports'].sort(),
    )
  })

  it('every declared export target exists on disk (built artifacts included)', () => {
    const distExists = existsSync(join(PKG_ROOT, 'dist'))
    if (!distExists) {
      throw new Error(
        'dist/ is missing — the exports map can only be proven against built artifacts. ' +
          'Run `pnpm build` (or `pnpm --filter @printchecks/cheque-core build`) first. ' +
          'The root test script does this automatically.',
      )
    }

    const pkg = readPkgJson()
    const targets = collectExportTargets(pkg.exports)
    expect(targets.length).toBeGreaterThan(0)

    const missing = targets.filter((t) => !existsSync(join(PKG_ROOT, t.target)))
    expect(missing, 'declared export targets that do not exist').toEqual([])

    // Top-level entry pointers must exist too.
    for (const field of ['main', 'module', 'types'] as const) {
      const target = pkg[field]
      expect(target, `package.json "${field}"`).toBeDefined()
      expect(existsSync(join(PKG_ROOT, target as string)), `package.json "${field}" -> ${target}`).toBe(true)
    }
  })

  it('detects a missing declared export target (regression harness self-check)', () => {
    // The historical defect, replayed against the checker itself: tsup emits .js/.cjs,
    // never .mjs, so a map declaring "*.mjs" MUST be reported as broken. If this fails,
    // the existence check above has rotted into a no-op and can no longer catch the bug
    // it exists for.
    const historicalBrokenMap = {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs', // never emitted by tsup
        require: './dist/index.js',
      },
    }
    const targets = collectExportTargets(historicalBrokenMap)
    const missing = targets.filter((t) => !existsSync(join(PKG_ROOT, t.target)))

    expect(missing).toContainEqual({
      subpath: '.',
      condition: 'import',
      target: './dist/index.mjs',
    })
  })

  for (const subpath of SUBPATHS) {
    it(`external ESM consumer can import "${subpath}" through the exports map`, () => {
      const { status, output } = runNode('import', subpath)
      expect(
        status,
        `node --input-type=module -e "import('${PKG_NAME}${subpath}')" failed:\n${output}`,
      ).toBe(0)
    })

    it(`external CJS consumer can require "${subpath}" through the exports map`, () => {
      const { status, output } = runNode('require', subpath)
      expect(status, `node -e "require('${PKG_NAME}${subpath}')" failed:\n${output}`).toBe(0)
    })
  }
})
