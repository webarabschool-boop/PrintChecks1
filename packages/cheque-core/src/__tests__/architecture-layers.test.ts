import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Architecture layer enforcement.
 *
 * The roadmap's GATE 0 checks were written for a two-package split (`packages/domain` and
 * `packages/application`). This package keeps those layers as directories instead, so the
 * boundary has to be enforced by something other than the package graph — otherwise
 * `domain/` could quietly start importing from `application/` and the whole separation
 * would erode without any test failing.
 *
 * These tests ARE that enforcement. They run in the normal suite, so a layering violation
 * fails the build.
 *
 * Allowed dependency direction (each layer may import only from layers below it):
 *
 *     application  ->  domain, ports, infrastructure
 *     infrastructure -> domain, ports
 *     ports        ->  domain (types only)
 *     domain       ->  (nothing outside itself)
 */

// src/__tests__/ -> src/
const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Source files of a layer, excluding its tests. */
function layerFiles(layer: string): string[] {
  return walk(join(SRC_ROOT, layer)).map((f) => relative(SRC_ROOT, f).split(sep).join('/'))
}

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

/** Every module specifier a file imports from. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:[\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

/** Resolve a relative specifier to a top-level layer directory, or null if external. */
function targetLayer(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const fromDir = fromFile.slice(0, fromFile.lastIndexOf('/'))
  const parts = [...fromDir.split('/'), ...specifier.split('/')]

  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return resolved[0] ?? null
}

describe('layer boundaries', () => {
  it('has all four layers present', () => {
    for (const layer of ['domain', 'ports', 'application', 'infrastructure']) {
      expect(layerFiles(layer).length, `${layer} should contain source files`).toBeGreaterThan(0)
    }
  })

  it('domain imports nothing from application, infrastructure or ports', () => {
    const violations: string[] = []

    for (const file of layerFiles('domain')) {
      for (const specifier of importSpecifiers(read(file))) {
        const target = targetLayer(file, specifier)
        if (target !== null && target !== 'domain') {
          violations.push(`${file} -> ${specifier} (layer "${target}")`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('ports import only from domain', () => {
    const violations: string[] = []

    for (const file of layerFiles('ports')) {
      for (const specifier of importSpecifiers(read(file))) {
        const target = targetLayer(file, specifier)
        if (target !== null && target !== 'ports' && target !== 'domain') {
          violations.push(`${file} -> ${specifier} (layer "${target}")`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('infrastructure imports only from domain and ports', () => {
    const violations: string[] = []

    for (const file of layerFiles('infrastructure')) {
      for (const specifier of importSpecifiers(read(file))) {
        const target = targetLayer(file, specifier)
        const allowed = target === null || target === 'infrastructure' || target === 'domain' || target === 'ports'
        if (!allowed) {
          violations.push(`${file} -> ${specifier} (layer "${target}")`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('no layer uses require() — ESM only', () => {
    const offenders: string[] = []
    for (const layer of ['domain', 'ports', 'application', 'infrastructure']) {
      for (const file of layerFiles(layer)) {
        if (/\brequire\s*\(/.test(read(file))) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

/** Strip comments but KEEP string literals — needed to inspect import specifiers. */
function commentsOnly(source: string): string {
  const keepNewlines = (match: string): string => match.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, keepNewlines).replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Strip comments and string literals, preserving line structure.
 *
 * The isolation rules are about CODE reaching for a platform API — not about prose.
 * `TRANSACTIONALITY.bestEffort` legitimately contains the word "localStorage" while
 * explaining what an adapter cannot guarantee, and doc comments name the things being
 * avoided. Testing raw source would flag both, so they are removed first.
 */
function codeOnly(source: string): string {
  const keepNewlines = (match: string): string => match.replace(/[^\n]/g, ' ')

  return commentsOnly(source)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, keepNewlines) // template literals
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''") // single-quoted strings
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""') // double-quoted strings
}

describe('platform isolation (GATE 0)', () => {
  /**
   * The domain must be framework- and platform-agnostic. `application/` is included in the
   * sweep because use cases orchestrate the domain through ports and must not reach for a
   * browser global directly either — only `infrastructure/` may touch platform APIs.
   */
  const forbidden: Array<[string, RegExp]> = [
    ["import from 'vue'", /from\s+['"]vue['"]/],
    ["import from 'pinia'", /from\s+['"]pinia['"]/],
    ['window.', /\bwindow\s*\./],
    ['document.', /\bdocument\s*\./],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['navigator.', /\bnavigator\s*\./],
    ['alert/confirm/prompt', /\b(?:window\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/],
  ]

  for (const layer of ['domain', 'application']) {
    it(`${layer}/ contains no DOM, Vue or browser-storage references`, () => {
      const violations: string[] = []

      for (const file of layerFiles(layer)) {
        // Import specifiers are themselves string literals, so they must be matched
        // against a version with comments removed but strings INTACT — codeOnly() would
        // erase `from 'vue'` and make the check unable to ever fire.
        const rawSource = read(file)
        const withStrings = commentsOnly(rawSource)
        for (const [label, pattern] of forbidden) {
          if (!label.startsWith('import')) continue
          if (pattern.test(withStrings)) violations.push(`${file}: ${label}`)
        }

        const lines = codeOnly(rawSource).split('\n')
        lines.forEach((line, index) => {
          for (const [label, pattern] of forbidden) {
            if (label.startsWith('import')) continue
            if (pattern.test(line)) {
              violations.push(`${file}:${index + 1}: ${label} -> ${line.trim().slice(0, 90)}`)
            }
          }
        })
      }

      expect(violations).toEqual([])
    })
  }

  it('domain/ never reads a clock or random source directly', () => {
    // Entities receive timestamps; only infrastructure may mint them.
    const violations: string[] = []
    for (const file of layerFiles('domain')) {
      const source = read(file)
      if (/\bMath\s*\.\s*random\b/.test(source)) violations.push(`${file}: Math.random`)
      if (/\bDate\s*\.\s*now\b/.test(source)) violations.push(`${file}: Date.now`)
    }
    expect(violations).toEqual([])
  })

  it('no source file parses a complete cheque number numerically', () => {
    // The single non-negotiable rule of cheque numbering.
    //
    // Matching is deliberately narrow to avoid false positives: the identifier must be the
    // lowercase `chequeNumber` (the class `ChequeNumber` and methods such as
    // `peekNextChequeNumber` must not match), and `Number(` must not be preceded by an
    // identifier character, so `new ChequeNumber(raw)` and `hasChequeNumber(...)` are not
    // flagged.
    //
    // `decomposeSequence` is the one sanctioned exception: it parses the digits AFTER a
    // caller-supplied prefix, never the complete value, and is covered by its own tests.
    const EXCEPTION = 'sequence/ChequeBookSequence.ts'

    const coercions: Array<[string, RegExp]> = [
      ['parseInt', /\bparseInt\s*\(/],
      ['parseFloat', /\bparseFloat\s*\(/],
      ['Number(...)', /(?<![A-Za-z_$])Number\s*\(/],
      ['Number.parseInt/parseFloat', /\bNumber\s*\.\s*(?:parseInt|parseFloat)\b/],
      ['unary +', /\+\s*chequeNumber/],
    ]

    const violations: string[] = []
    const allFiles = [
      ...layerFiles('domain'),
      ...layerFiles('ports'),
      ...layerFiles('application'),
      ...layerFiles('infrastructure'),
    ]

    for (const file of allFiles) {
      if (file.endsWith(EXCEPTION)) continue

      codeOnly(read(file))
        .split('\n')
        .forEach((line, index) => {
          // Case-sensitive: only the value identifier, never the ChequeNumber type.
          if (!/chequeNumber/.test(line)) return
          for (const [label, pattern] of coercions) {
            if (pattern.test(line)) {
              violations.push(`${file}:${index + 1}: ${label} -> ${line.trim().slice(0, 90)}`)
            }
          }
        })
    }

    expect(violations).toEqual([])
  })

  it('the sanctioned exception only parses digits after a known prefix', () => {
    // decomposeSequence is allowed to read a numeric sequence component, but only by
    // stripping a caller-supplied prefix first and requiring the remainder to be all
    // digits. It must never coerce the complete cheque number.
    const source = codeOnly(read('domain/sequence/ChequeBookSequence.ts'))

    expect(source).toContain('export function decomposeSequence')
    // The whole-value coercions must not appear anywhere in the sequence module.
    expect(source).not.toMatch(/parseFloat\s*\(/)
    expect(source).not.toMatch(/\bNumber\s*\(\s*chequeNumber/)
    expect(source).not.toMatch(/\+\s*chequeNumber/)
    // The one parseInt is applied to the post-prefix remainder, not the full number.
    expect(source).toMatch(/parseInt\(remainder/)
  })
})

describe('public surface', () => {
  it('exposes the four layer entry points as subpath exports', () => {
    const pkg = JSON.parse(readFileSync(join(SRC_ROOT, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }

    for (const subpath of ['.', './domain', './ports', './application', './infrastructure']) {
      expect(pkg.exports[subpath], `missing export "${subpath}"`).toBeDefined()
    }
  })

  it('the domain entry point re-exports the core model', () => {
    const barrel = read('domain/index.ts')
    expect(barrel).toContain('./entities/index')
    expect(barrel).toContain('./errors')
    expect(barrel).toContain('./sequence/index')
    expect(barrel).toContain('./value-objects/index')
    expect(barrel).toContain('./lifecycle/index')
  })
})
