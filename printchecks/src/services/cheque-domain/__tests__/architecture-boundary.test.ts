import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Architecture guard for the Phase 1 application boundary.
 *
 * Enforces the two dependency rules that keep the integration honest:
 *
 *   1. `@printchecks/cheque-core` may ONLY be imported inside
 *      `src/services/cheque-domain/**`, and only through the package ROOT entry
 *      (`@printchecks/cheque-core`, never a /dist or deep-file path).
 *   2. Modules inside the boundary must never import UI layers: no .vue files,
 *      no components/views/stores/router, no vue/pinia framework entry points.
 *
 * The rules are checked on the source tree so a violation fails in CI, not in review.
 */

// __tests__ -> cheque-domain -> services -> src
const SRC_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const BOUNDARY_DIR_REL = join('services', 'cheque-domain')

const SOURCE_EXTENSIONS = new Set(['.ts', '.vue', '.tsx', '.js', '.mjs'])

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(full)
    }
  }
  return files
}

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (typeof specifier === 'string') specifiers.push(specifier)
  }
  return specifiers
}

function isInsideBoundary(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).join('/').startsWith(BOUNDARY_DIR_REL.split(/[\\/]/).join('/'))
}

describe('application boundary architecture guard', () => {
  const files = collectSourceFiles(SRC_ROOT)
  const withImports = files.map((file) => ({
    file,
    relativePath: relative(SRC_ROOT, file),
    imports: importSpecifiers(readFileSync(file, 'utf8')),
  }))

  it('scanned a non-trivial amount of source files', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('no module outside the boundary imports @printchecks/cheque-core', () => {
    const violations: string[] = []
    for (const { relativePath, imports } of withImports) {
      if (isInsideBoundary(relativePath)) continue
      for (const specifier of imports) {
        if (specifier === '@printchecks/cheque-core' || specifier.startsWith('@printchecks/cheque-core/')) {
          violations.push(`${relativePath} imports ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the boundary itself imports cheque-core only through the package root entry', () => {
    const violations: string[] = []
    for (const { relativePath, imports } of withImports) {
      if (!isInsideBoundary(relativePath)) continue
      for (const specifier of imports) {
        if (specifier.startsWith('@printchecks/cheque-core/')) {
          violations.push(`${relativePath} uses deep import ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('boundary modules never import UI-layer modules', () => {
    const forbidden = [
      /^vue$/,
      /^@vue\//,
      /^pinia$/,
      /\.vue$/,
      /(^|[/\\])components([/\\]|$)/,
      /(^|[/\\])views([/\\]|$)/,
      /(^|[/\\])stores([/\\]|$)/,
      /(^|[/\\])router([/\\]|$)/,
    ]
    const violations: string[] = []
    for (const { relativePath, imports } of withImports) {
      if (!isInsideBoundary(relativePath)) continue
      for (const specifier of imports) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          violations.push(`${relativePath} imports UI-layer module "${specifier}"`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('boundary modules never parse a complete cheque number numerically', () => {
    // Belt-and-braces companion to the core's own rule: no parseInt/Number() on a
    // cheque number string anywhere in the boundary source. The static scan looks for
    // the parseInt/Number identifier adjacent to "chequeNumber" in the same statement.
    const numericParseCall = /(parseInt|Number\.parseInt|(?<![\w.])Number)\s*\([^)]*[Cc]heque[Nn]umber/
    const violations: string[] = []
    for (const { relativePath } of withImports) {
      if (!isInsideBoundary(relativePath)) continue
      const source = readFileSync(join(SRC_ROOT, relativePath), 'utf8')
      for (const match of source.matchAll(new RegExp(numericParseCall, 'g'))) {
        violations.push(`${relativePath}: ${match[0]}...`)
      }
    }
    expect(violations).toEqual([])
  })
})
