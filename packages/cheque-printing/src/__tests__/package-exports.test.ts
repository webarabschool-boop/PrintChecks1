import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Package export regression test.
 *
 * The exports map is a contract with the application, and nothing else in this suite exercises it:
 * every other test imports TypeScript source directly, so a declared subpath that tsup never emits,
 * a wrong ESM/CJS extension, or a barrel that silently drops a module ships green. `cheque-core`
 * already tripped on exactly that, which is why the check exists here too.
 *
 * These tests consume the package the way the app does — by resolving the package NAME through its
 * own exports map (Node self-reference resolution) against the BUILT artifacts — so they only mean
 * something after a build. The root `test` script builds this package first; standalone runs must do
 * the same:
 *
 *     pnpm --filter @printchecks/cheque-printing build && pnpm --filter @printchecks/cheque-printing test
 */

// src/__tests__/package-exports.test.ts -> package root
const PKG_ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

const PKG_NAME = '@printchecks/cheque-printing'

interface PkgJson {
  main?: string
  module?: string
  types?: string
  exports: Record<string, string | Record<string, string>>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPkgJson(): PkgJson {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as PkgJson
}

/**
 * Flatten the exports map into (subpath, condition, target) triples. Condition objects may nest
 * (`{"node": {"import": "..."}}`), and a bare string subpath (`./package.json`) has no condition.
 */
function collectExportTargets(
  exportsMap: Record<string, string | Record<string, string>>
): Array<{ subpath: string; condition: string; target: string }> {
  const out: Array<{ subpath: string; condition: string; target: string }> = []

  const walk = (value: unknown, subpath: string, condition: string): void => {
    if (typeof value === 'string') {
      out.push({ subpath, condition: condition === '' ? '(default)' : condition, target: value })
    } else if (Array.isArray(value)) {
      for (const entry of value) walk(entry, subpath, condition)
    } else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(nested, subpath, condition === '' ? key : `${condition}.${key}`)
      }
    }
  }

  for (const [subpath, value] of Object.entries(exportsMap)) {
    walk(value, subpath, '')
  }
  return out
}

/**
 * Names each subpath must expose AT RUNTIME. Types are deliberately absent: a `type` export proves
 * nothing about the shipped JavaScript, and the failure mode this file exists for is exactly "the
 * types were fine and the runtime file was missing".
 */
const EXPECTED_EXPORTS: Record<string, string[]> = {
  '.': ['createBankChequeTemplate', 'buildPrintLayout', 'assessPrintSafety', 'ChequePrintingService', 'ChequePrintingError', 'roundMm', 'MM_DECIMALS'],
  './template': [
    'createBankChequeTemplate',
    'createTemplateField',
    'validateTemplate',
    'assertTemplateValid',
    'TemplateRegistry',
    'BUILTIN_TEMPLATES',
    'computeTemplateHash',
    'nextTemplateVersion',
  ],
  './printdata': [
    'createChequePrintData',
    'validateChequePrintData',
    'analyseText',
    'detectBaseDirection',
    'applyBidiIsolation',
    'formatDate',
    'formatAmount',
    'padNumber',
  ],
  './layout': ['buildPrintLayout', 'measureTextMm', 'fitTextToWidth', 'wrapText', 'stackLines', 'toPreviewLayout'],
  './printer': [
    'createPrinterProfile',
    'validatePrinterProfile',
    'createPrinterCalibration',
    'validatePrinterCalibration',
    'deriveCalibration',
    'calibrationKey',
    'transformPoint',
    'transformRect',
    'buildRegistrationTestPage',
    'renderTestPageDocument',
    'DEFAULT_CALIBRATION_LIMITS',
    'DEFAULT_UNPRINTABLE_MARGIN_MM',
  ],
  './printing': [
    'createPrintJob',
    'transitionJob',
    'retryJob',
    'verifyJobRecord',
    'computeJobHash',
    'assessPrintSafety',
    'assertSafetyCleared',
    'createConfirmation',
    'renderPrintDocument',
    'appendAuditRecord',
    'verifyAuditChain',
    'maskAccountNumber',
    'GENESIS_HASH',
    'PRINT_AUDIT_ACTIONS',
  ],
  './ports': ['UnavailableAmountInWordsConverter'],
  './application': ['ChequePrintingService'],
  './infrastructure': [
    'InMemoryPrintingRecordStore',
    'PRINTING_STORAGE_NAMESPACE',
    'PRINTING_KEY_PREFIXES',
    'TemplateRecordRepository',
  ],
  './browser': ['IframePrintTransport'],
}

const SUBPATHS = Object.keys(EXPECTED_EXPORTS)

function moduleSpecifier(subpath: string): string {
  return subpath === '.' ? PKG_NAME : `${PKG_NAME}${subpath.slice(1)}`
}

function runNode(mode: 'import' | 'require', subpath: string): { status: number; output: string } {
  const expected = JSON.stringify(EXPECTED_EXPORTS[subpath] ?? [])
  const specifier = JSON.stringify(moduleSpecifier(subpath))
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
    { cwd: PKG_ROOT, encoding: 'utf8' }
  )
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

describe('package exports map', () => {
  it('declares exactly the intended public subpaths', () => {
    const pkg = readPkgJson()
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [
        '.',
        './application',
        './browser',
        './infrastructure',
        './layout',
        './package.json',
        './printer',
        './printing',
        './ports',
        './printdata',
        './template',
      ].sort()
    )
  })

  it('every declared export target exists on disk (built artifacts included)', () => {
    if (!existsSync(join(PKG_ROOT, 'dist'))) {
      throw new Error(
        'dist/ is missing — the exports map can only be proven against built artifacts. ' +
          'Run `pnpm --filter @printchecks/cheque-printing build` first (the root test script does this).'
      )
    }
    const pkg = readPkgJson()
    const targets = collectExportTargets(pkg.exports)
    expect(targets.length).toBeGreaterThan(0)
    const missing = targets.filter((entry) => !existsSync(join(PKG_ROOT, entry.target)))
    expect(missing, 'declared export targets that do not exist').toEqual([])

    for (const field of ['main', 'module', 'types'] as const) {
      const target = pkg[field]
      expect(target, `package.json "${field}"`).toBeDefined()
      expect(existsSync(join(PKG_ROOT, target as string)), `package.json "${field}" -> ${String(target)}`).toBe(true)
    }
  })

  it('ships no runtime dependency, so the engine cannot drag the app graph into a worker', () => {
    const pkg = readPkgJson()
    expect(pkg.dependencies ?? {}).toEqual({})
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      expect(version, `devDependency "${name}" must be a workspace-free version`).not.toMatch(/^workspace:/)
    }
  })

  it('detects a missing declared export target (regression harness self-check)', () => {
    // tsup with `"format": ["cjs", "esm"]` in an ESM package emits `dist/*.js` and `dist/*.cjs`,
    // never `.mjs`. A map declaring `*.mjs` MUST be reported as broken — if this fails, the
    // existence check above has rotted into a no-op.
    const historicalBrokenMap = {
      '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.js' },
    }
    const missing = collectExportTargets(historicalBrokenMap).filter(
      (entry) => !existsSync(join(PKG_ROOT, entry.target))
    )
    expect(missing).toContainEqual({ subpath: '.', condition: 'import', target: './dist/index.mjs' })
  })

  for (const subpath of SUBPATHS) {
    it(`external ESM consumer can import "${subpath}" through the exports map`, () => {
      const { status, output } = runNode('import', subpath)
      expect(status, `node --input-type=module -e "import('${moduleSpecifier(subpath)}')" failed:\n${output}`).toBe(0)
    })

    it(`external CJS consumer can require "${subpath}" through the exports map`, () => {
      const { status, output } = runNode('require', subpath)
      expect(status, `node -e "require('${moduleSpecifier(subpath)}')" failed:\n${output}`).toBe(0)
    })
  }
})

describe('the printed document is a string, end to end', () => {
  it('a consumer can stage, render and inspect a cheque using only built artifacts', async () => {
    const script = `
const {
  InMemoryPrintingRecordStore,
  ChequePrintingService,
  createChequePrintData,
} = await import(${JSON.stringify(PKG_NAME)});
const service = new ChequePrintingService({
  store: new InMemoryPrintingRecordStore(),
  seedBuiltins: true,
  policy: { requireCalibration: false },
  amountInWords: {
    id: 'inline-test',
    supportedLocales: ['en'],
    convert: () => ({ words: 'one thousand five hundred pounds only', converterId: 'inline-test', usedLocale: 'en' }),
  },
  now: () => '2026-09-18T09:00:00.000Z',
});
await service.saveProfile({ id: 'p', name: 'Test printer', supportsCustomPageSize: true });
const preview = await service.preview({
  templateId: 'nbe-personal-en-2024',
  data: createChequePrintData({
    chequeId: 'c1',
    chequeNumber: '001234',
    date: '2026-09-18',
    payeeName: 'Crescent Trading LLC',
    amountDecimal: '1500.00',
    currency: 'EGP',
  }),
  printerProfileId: 'p',
});
const html = preview.layout.runs.length;
if (html < 3) { console.error('too few runs laid out: ' + String(html)); process.exit(1); }
const page = await service.generateTestPage({ profileId: 'p', templateId: 'nbe-personal-en-2024' });
if (!page.html.includes('@page { size: 210mm 85mm; margin: 0mm; }')) {
  console.error('test page did not carry the stock geometry in millimetres');
  process.exit(1);
}
if (typeof globalThis.window !== 'undefined' || typeof globalThis.document !== 'undefined') {
  console.error('the built engine touched a DOM global');
  process.exit(1);
}
process.stdout.write('OK ' + String(html));
`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    })
    expect(result.stderr.trim(), 'node reported an error').toBe('')
    expect(result.stdout.trim()).toMatch(/^OK [3-9]\d*$/)
  })
})
