import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Boundary enforcement for the printing engine.
 *
 * The engine is one package with twelve directories inside it, so the layering that matters —
 * geometry and layout must not know about printers, printers must not know about the browser, and
 * only one module may touch the DOM — cannot be expressed as a package graph. These tests are what
 * keeps it honest: the moment `template/` starts importing the application facade, or a layout
 * helper reaches for `window`, the suite fails instead of quietly eroding.
 *
 * Layers:
 *
 *   geometry, canonical, errors, html, printdata, template, layout, printer, printing, ports
 *       the engine — usable on a server, in a worker, in a test
 *   application, infrastructure, browser
 *       the host — wiring, persistence, the one place the DOM is touched
 */

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Engine layers: nothing in here may depend on the host layers. */
const ENGINE = ['geometry', 'canonical', 'html', 'printdata', 'template', 'layout', 'printer', 'printing', 'ports'] as const
/** Engine modules that sit at the root of `src/` rather than in a directory of their own. */
const ENGINE_ROOT_MODULES = ['errors.ts']
/** Host layers, and what each may not reach for. */
const HOST = ['application', 'infrastructure', 'browser'] as const

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

function layerFiles(layer: string): string[] {
  return walk(join(SRC_ROOT, layer)).map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
}

function engineFiles(): string[] {
  return [...ENGINE.flatMap((layer) => layerFiles(layer)), ...ENGINE_ROOT_MODULES]
}

function allFiles(): string[] {
  return [...engineFiles(), ...HOST.flatMap((layer) => layerFiles(layer))]
}

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

/** Strip comments, keeping string literals — for matching import specifiers. */
function commentsOnly(source: string): string {
  const keepNewlines = (match: string): string => match.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, keepNewlines).replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Strip comments and string literals, preserving line structure.
 *
 * The isolation rules are about CODE reaching for a platform API, not about prose: a doc comment
 * explaining that `window.print()` is not the engine would otherwise read as a violation, as would
 * the CSS the renderer assembles into a string.
 */
function codeOnly(source: string): string {
  const keepNewlines = (match: string): string => match.replace(/[^\n]/g, ' ')
  return commentsOnly(source)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, keepNewlines)
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""')
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of commentsOnly(source).matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

/** Which top-level directory a relative specifier lands in, or null when it leaves the layer set. */
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
  const top = resolved[0]
  if (top === undefined || top === '..') return null
  return top
}

describe('layer direction', () => {
  it('has every layer present, so a rename cannot vacate a rule', () => {
    for (const layer of [...ENGINE, ...HOST]) {
      expect(layerFiles(layer).length, `${layer}/ should contain source files`).toBeGreaterThan(0)
    }
    for (const file of ENGINE_ROOT_MODULES) {
      expect(read(file).length, `${file} should not be empty`).toBeGreaterThan(0)
    }
  })

  it('the engine never imports the host', () => {
    const violations: string[] = []
    for (const file of engineFiles()) {
      for (const specifier of importSpecifiers(read(file))) {
        const target = targetLayer(file, specifier)
        if (target !== null && (HOST as readonly string[]).includes(target)) {
          violations.push(`${file} -> ${specifier} (layer "${target}")`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('infrastructure and browser stay beneath the application facade', () => {
    // The facade wires repositories and a transport; neither may call back into it, or the app ends
    // up with two entry points that disagree about who owns the state.
    const violations: string[] = []
    for (const file of [...layerFiles('infrastructure'), ...layerFiles('browser')]) {
      for (const specifier of importSpecifiers(read(file))) {
        const target = targetLayer(file, specifier)
        if (target === 'application' || (file.startsWith('infrastructure') && target === 'browser')) {
          violations.push(`${file} -> ${specifier} (layer "${target}")`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('no framework, and no import of the Phase 1 domain package', () => {
    // `@printchecks/cheque-core` owns the cheque lifecycle. This package consumes it through the
    // application's adapters; importing it here would let two packages own the same rules, and
    // would make the engine untestable outside the app.
    const forbidden = [
      /^vue$/,
      /^pinia$/,
      /^@vueuse\//,
      /^@printchecks\/core$/,
      /^@printchecks\/vue$/,
      /^@printchecks\/cheque-core$/,
    ]
    const violations: string[] = []
    for (const file of allFiles()) {
      for (const specifier of importSpecifiers(read(file))) {
        if (forbidden.some((pattern) => pattern.test(specifier))) violations.push(`${file} -> ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('is ESM only, with no require() and no random source', () => {
    const offenders: string[] = []
    for (const file of allFiles()) {
      const code = codeOnly(read(file))
      if (/\brequire\s*\(/.test(code)) offenders.push(`${file}: require()`)
      // Determinism by construction: ids, timestamps and hashes arrive through ports and factories.
      if (/\bMath\s*\.\s*random\b/.test(code)) offenders.push(`${file}: Math.random`)
      if (/\bDate\s*\.\s*now\b/.test(code)) offenders.push(`${file}: Date.now`)
    }
    expect(offenders).toEqual([])
  })
})

describe('the DOM belongs to exactly one module', () => {
  // Patterns are deliberately about the GLOBAL objects, not the words: a rendered document is
  // `document` in this codebase's own sense (`document.bytes`, `documentFingerprint(html, …)`), and
  // a property access on it is not a DOM touch. Member names are enumerated instead.
  const domGlobals: Array<[string, RegExp]> = [
    ['window.', /(?<![.\w$])window\s*[.[]/],
    ['document.*', /(?<![.\w$])document\s*\.\s*(?:body|head|documentElement|defaultView|createElement|querySelector|getElementById|write|writeln|fonts|title)\b/],
    ['navigator.', /(?<![.\w$])navigator\s*\./],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['HTMLElement', /\bHTMLElement\b/],
    ['iframe', /\biframe\b/i],
    ['new Blob(', /\bnew\s+Blob\s*\(/],
    ['URL.createObjectURL', /\bURL\s*\.\s*createObjectURL\b/],
    ['matchMedia(', /\bmatchMedia\s*\(/],
    ['requestAnimationFrame(', /\brequestAnimationFrame\s*\(/],
    ['setTimeout in the engine', /\bsetTimeout\s*\(/],
  ]

  for (const layer of [...ENGINE, 'application', 'infrastructure']) {
    it(`${layer}/ contains no DOM access`, () => {
      const violations: string[] = []
      for (const file of layerFiles(layer)) {
        codeOnly(read(file))
          .split('\n')
          .forEach((line, index) => {
            for (const [label, pattern] of domGlobals) {
              if (pattern.test(line)) violations.push(`${file}:${index + 1}: ${label} -> ${line.trim().slice(0, 90)}`)
            }
          })
      }
      expect(violations).toEqual([])
    })
  }

  it('nothing calls window.print() — that is the whole reason a transport port exists', () => {
    // `window.print()` prints the page the operator is looking at: the dashboard, the sidebar, the
    // wrong thing. The transport prints an iframe it built, and this suite keeps it that way.
    const offenders: string[] = []
    for (const file of allFiles()) {
      if (/\bwindow\s*\.\s*print\s*\(/.test(codeOnly(read(file)))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('the browser transport is a PrintTransport and nothing more', () => {
    const source = read('browser/IframePrintTransport.ts')
    expect(source).toContain('implements PrintTransport')
    expect(source).toContain('../ports/transport')
    // It renders the document it was handed; it does not lay anything out or re-hash the cheque.
    expect(source).not.toContain('buildPrintLayout')
    expect(source).not.toContain('assessPrintSafety')
  })
})

describe('the print output is data, not markup', () => {
  it('the renderer and the document builder never assign innerHTML', () => {
    // Everything reaching the printer is assembled as a string and validated before it is handed to
    // a transport; parsing it back into live nodes would reopen the hole the validation closes.
    for (const file of ['printing/render.ts', 'html/document.ts']) {
      expect(codeOnly(read(file)), file).not.toMatch(/\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b/)
    }
  })

  it('preview-only guidance never reaches the renderer', () => {
    // The layout carries both: runs go to the paper, guides are for the designer's screen only.
    const render = read('printing/render.ts')
    expect(render).toContain('run.isPrinted')
    expect(render).not.toContain('layout.guides')
  })
})

describe('public surface', () => {
  it('the root barrel exposes the engine and the wiring, but not the browser adapter', () => {
    const barrel = read('index.ts')
    for (const layer of ['geometry', 'template', 'printdata', 'layout', 'printer', 'printing', 'ports', 'application', 'infrastructure', 'errors', 'canonical']) {
      expect(barrel, `root barrel should re-export ./${layer}`).toContain(`./${layer}`)
    }
    // `./browser` is reachable only through its own subpath: importing the root barrel must never
    // pull DOM code into a worker or a server bundle.
    expect(barrel).not.toContain("from './browser'")
    expect(barrel).not.toContain("from './html'")
  })

  it('every layer entry point is a subpath export', () => {
    const pkg = JSON.parse(readFileSync(join(SRC_ROOT, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
    }
    for (const subpath of [
      '.',
      './template',
      './printdata',
      './layout',
      './printer',
      './printing',
      './ports',
      './application',
      './infrastructure',
      './browser',
    ]) {
      expect(pkg.exports[subpath], `missing export "${subpath}"`).toBeDefined()
    }
    // Internal helpers stay out of the map: geometry and canonical are reachable through the barrels
    // that need them, and `html` (the document builder) is not a contract of its own at all.
    expect(pkg.exports['./html']).toBeUndefined()
    expect(pkg.exports['./geometry']).toBeUndefined()
    expect(pkg.exports['./canonical']).toBeUndefined()
  })

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(SRC_ROOT, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    // The engine ships geometry and HTML strings; the app owns the printers, the storage and the UI.
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.peerDependencies ?? {}).toEqual({})
  })
})
