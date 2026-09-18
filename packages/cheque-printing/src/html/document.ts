/**
 * HTML/CSS assembly for print documents.
 *
 * Kept free of `template/`, `layout/` and `printer/` imports so both the cheque print document and
 * the calibration test page can build markup from the same primitives — one definition of what
 * "a print-stable absolutely-positioned run" looks like, rather than two that drift.
 *
 * There is no DOM here: the output is a string. That is what makes the print path unit-testable in
 * bare Node (TT1) and lets a backend produce the identical artefact.
 */

export function escapeHtml(value: string): string {
  let out = ''
  for (const char of value) {
    switch (char) {
      case '&':
        out += '&amp;'
        break
      case '<':
        out += '&lt;'
        break
      case '>':
        out += '&gt;'
        break
      case '"':
        out += '&quot;'
        break
      case "'":
        out += '&#39;'
        break
      default:
        out += char
    }
  }
  return out
}

/** Escape for a CSS declaration value: quotes and backslashes would break out of the property. */
export function escapeCssIdent(value: string): string {
  return value.replace(/["'\\;{}]/g, '').trim()
}

/** Only named families survive into the document; a font stack from a template is untrusted input. */
export function sanitizeFontFamily(value: string): string {
  const cleaned = escapeCssIdent(value)
  return cleaned === '' ? 'serif' : `"${cleaned}"`
}

export function styleDeclarations(entries: Readonly<Record<string, string | number>>): string {
  const parts: string[] = []
  for (const [property, value] of Object.entries(entries)) {
    if (value === '' || Number.isNaN(value)) continue
    parts.push(`${property}:${String(value)}`)
  }
  return parts.join(';')
}

export interface PageCssInput {
  readonly widthMm: number
  readonly heightMm: number
  readonly marginMm: number
  /** `@page` accepts mm directly — this is the whole point of the mm-first design. */
}

export function pageCss(input: PageCssInput): string {
  return [
    `@page { size: ${String(input.widthMm)}mm ${String(input.heightMm)}mm; margin: ${String(input.marginMm)}mm; }`,
    'html, body { margin: 0; padding: 0; }',
    `body { width: ${String(input.widthMm)}mm; height: ${String(input.heightMm)}mm; position: relative; overflow: hidden; background: #ffffff; }`,
    // Colour management for a data-only print: exact, no browser "shrink to fit" surprises.
    '* { box-sizing: border-box; }',
  ].join('\n')
}

export interface DocumentMeta {
  readonly documentKind: string
  readonly templateId?: string
  readonly templateVersion?: number
  readonly templateHash?: string
  readonly layoutHash?: string
  readonly jobId?: string
  readonly runCount?: number
}

/**
 * Metadata travels with the document so a sheet photographed after printing can be tied back to
 * its record: which template version, which layout, which job. This is the print-side counterpart
 * of the audit chain (A4).
 */
export function metaTags(meta: DocumentMeta): string {
  const attributes: string[] = [`data-document-kind="${escapeHtml(meta.documentKind)}"`]
  if (meta.templateId !== undefined) attributes.push(`data-template-id="${escapeHtml(meta.templateId)}"`)
  if (meta.templateVersion !== undefined) attributes.push(`data-template-version="${String(meta.templateVersion)}"`)
  if (meta.templateHash !== undefined) attributes.push(`data-template-hash="${escapeHtml(meta.templateHash)}"`)
  if (meta.layoutHash !== undefined) attributes.push(`data-layout-hash="${escapeHtml(meta.layoutHash)}"`)
  if (meta.jobId !== undefined) attributes.push(`data-job-id="${escapeHtml(meta.jobId)}"`)
  if (meta.runCount !== undefined) attributes.push(`data-run-count="${String(meta.runCount)}"`)
  return `<div id="printchecks-document-meta" ${attributes.join(' ')}></div>`
}

export interface StandaloneDocumentInput {
  readonly title: string
  readonly css: string
  readonly body: string
  readonly lang: string
  readonly direction: 'ltr' | 'rtl'
  readonly meta: DocumentMeta
}

export function buildStandaloneDocument(input: StandaloneDocumentInput): string {
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(input.lang)}" dir="${input.direction}">`,
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${input.css}</style>`,
    '</head>',
    '<body>',
    metaTags(input.meta),
    input.body,
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * The data-only guarantee, asserted before a document is ever returned to a caller: no background
 * image, no external resource, no reference to the preview artwork. A print document that fetches
 * anything is both a privacy leak and a double-print of the bank's stock.
 */
export const FORBIDDEN_PRINT_MARKUP: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /background-image\s*:/i, why: 'a print document carries data, never a background' },
  { pattern: /background\s*:\s*url/i, why: 'a print document carries data, never a background' },
  { pattern: /<img\b/i, why: 'images (including the reference cheque artwork) must never reach the printer' },
  { pattern: /\burl\s*\(/i, why: 'external resources would be fetched at print time' },
  { pattern: /<script\b/i, why: 'a print document is inert markup' },
  { pattern: /<link\b[^>]*stylesheet/i, why: 'styles are inlined so the document renders identically offline' },
  { pattern: /@import/i, why: 'remote imports break determinism of a saved print record' },
  { pattern: /checkbg|check_bg|reference-?artwork|watermark/i, why: 'the preview-only bank artwork leaked into the print output' },
]

export interface ForbiddenMarkupViolation {
  readonly why: string
  readonly snippet: string
}

/**
 * The structure a print document may not have, with the run text removed from it.
 *
 * Text is escaped on the way in, so a payee called "Watermark & Sons" or "A. URL (trading)" is data
 * and must print; a `style=` attribute or a CSS rule mentioning `checkbg.png` is the printer being
 * told to paint the bank's artwork. Stripping text between tags is what lets the same pattern list
 * guard the second case without tripping on the first.
 */
function printableStructure(html: string): string {
  const styleBlocks: string[] = []
  const block = /<style[^>]*>([\s\S]*?)<\/style>/gi
  for (let match = block.exec(html); match !== null; match = block.exec(html)) {
    styleBlocks.push(match[1] ?? '')
  }
  const tagsAndAttributes = html.replace(/>([^<]*)</g, '><')
  return `${tagsAndAttributes}\n${styleBlocks.join('\n')}`
}

export function findForbiddenMarkup(html: string): ForbiddenMarkupViolation[] {
  const violations: ForbiddenMarkupViolation[] = []
  const structure = printableStructure(html)
  for (const { pattern, why } of FORBIDDEN_PRINT_MARKUP) {
    const match = pattern.exec(structure)
    if (match !== null) {
      const start = Math.max(0, (match.index ?? 0) - 40)
      violations.push({ why, snippet: structure.slice(start, start + 120).replace(/\s+/g, ' ') })
    }
  }
  return violations
}

/**
 * UTF-8 byte length without `TextEncoder`, so the same number comes out of Node, a worker and a
 * browser. `layoutHash`-adjacent bookkeeping (document size on the print record) uses this.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}
