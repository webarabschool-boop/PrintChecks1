/**
 * The print document — data and nothing but data.
 *
 * This is the file the whole phase exists for. The legacy defect (§7.5) was that the app printed the
 * bank's own form: captions, rules, an amount box with an opaque white background painted over the
 * pre-printed one, and a PNG of the artwork. Here, the ONLY things that reach the page are the runs
 * the layout engine resolved, positioned in absolute millimetres on a `@page` declared at the
 * template's physical size.
 *
 * Deliberate properties:
 * - the reference background exists in the *preview* layer only; this function never receives it, so
 *   it cannot print it by accident (plus an explicit `findForbiddenMarkup` assertion);
 * - no `window.print()`, no `document.head.appendChild(style)`, no live-screen DOM: the output is a
 *   string handed to an isolated transport;
 * - no `transform: scale()` as a precision mechanism (§8.7). The only `transform` emitted is an
 *   authored per-field rotation; device error is corrected by translation/scale in the calibration
 *   transform, which is applied to *coordinates*, and to font size proportionally.
 */

import { hashCanonical } from '../canonical/hash'
import { mmCss, ptCss, roundMm } from '../geometry/units'
import {
  buildStandaloneDocument,
  escapeCssIdent,
  escapeHtml,
  findForbiddenMarkup,
  pageCss,
  styleDeclarations,
  utf8ByteLength,
  type DocumentMeta,
} from '../html/document'
import type { PrintLayout, PlacedGlyphRun } from '../layout/types'
import { combinedScale, transformPoint, transformRect, type PrinterTransform } from '../printer/transform'
import type { PrinterCalibration, PrinterProfile } from '../printer/types'
import type { RenderedPrintDocument } from '../ports/transport'
import { PrintBlockedError, type PrintingIssue } from '../errors'

export interface RenderPrintDocumentInput {
  readonly layout: PrintLayout
  readonly profile: PrinterProfile
  readonly calibration?: PrinterCalibration | null
  readonly options?: {
    readonly title?: string
    readonly jobId?: string
    readonly templateName?: string
    readonly meta?: Partial<DocumentMeta>
    /** Overrides the profile's declared margin. Print geometry is always margin: 0. */
    readonly marginMm?: number
  }
}

export interface RenderedLine {
  readonly html: string
  readonly xMm: number
  readonly yMm: number
}

export function renderPrintDocument(input: RenderPrintDocumentInput): RenderedPrintDocument {
  const { layout, profile } = input
  const transform: PrinterTransform = {
    profile,
    calibration: input.calibration ?? null,
  }
  const scale = combinedScale(transform)
  const sizeScale = (scale.x + scale.y) / 2

  const printedRuns = layout.runs.filter((run) => run.isPrinted)
  const body: string[] = []
  const violations: PrintingIssue[] = []

  for (const run of printedRuns) {
    if (run.text.trim() === '') continue
    const lines = run.lines.length > 0 ? run.lines : [fallbackLine(run)]
    for (const line of lines) {
      if (line.text.trim() === '') continue
      const placed = transformRect(
        { xMm: line.xMm, yMm: line.yMm, widthMm: line.widthMm, heightMm: line.heightMm },
        transform
      )
      const fontSizePt = Math.round(run.fontSizePt * sizeScale * 100) / 100
      const letterSpacingPt =
        run.letterSpacingPt === undefined ? 0 : Math.round(run.letterSpacingPt * sizeScale * 100) / 100

      const declarations: Record<string, string | number> = {
        position: 'absolute',
        left: mmCss(placed.xMm),
        top: mmCss(placed.yMm),
        width: mmCss(placed.widthMm),
        height: mmCss(placed.heightMm),
        margin: 0,
        padding: 0,
        'font-family': sanitizeStack(run.fontFamily),
        'font-size': ptCss(fontSizePt),
        'font-weight': String(run.fontWeight),
        'font-style': run.fontStyle,
        color: '#000000',
        'line-height': mmCss(placed.heightMm),
        'text-align': run.alignH === 'center' ? 'center' : run.alignH === 'right' ? 'right' : 'left',
        // `pre` freezes the layout decision: the browser must not re-wrap what we already measured.
        'white-space': 'pre',
        overflow: run.overflowPolicy === 'clip' || run.truncated ? 'hidden' : 'visible',
        'letter-spacing': letterSpacingPt === 0 ? '0' : ptCss(letterSpacingPt),
        'z-index': String(run.zIndex),
      }
      if (run.rotationDeg !== 0) {
        declarations['transform'] = `rotate(${String(run.rotationDeg)}deg)`
        declarations['transform-origin'] = 'left center'
      }

      body.push(
        `<div class="pc-run" data-field="${escapeHtml(run.fieldId)}" data-role="${escapeHtml(run.role)}"` +
          ` dir="${run.direction}" lang="${escapeHtml(languageOf(run))}"` +
          ` style="${styleDeclarations(declarations)}">${escapeHtml(line.text)}</div>`
      )
    }
  }

  if (body.length === 0) {
    violations.push({
      code: 'EMPTY_PRINT_DOCUMENT',
      severity: 'error',
      message: 'the layout produced no printable runs at all — refusing to send an empty page to a printer',
      remediation: 'check that the template has printed fields and that the cheque has values',
    })
  }

  // Absolute millimetre positioning inside a page whose size is declared in millimetres is the
  // whole mechanism: no viewport units, no container queries, no scale().
  const css = pageCss({
    widthMm: layout.paper.widthMm,
    heightMm: layout.paper.heightMm,
    marginMm: input.options?.marginMm ?? 0,
  })

  const meta: DocumentMeta = {
    documentKind: 'cheque-print-data',
    templateId: layout.templateId,
    templateVersion: layout.templateVersion,
    templateHash: layout.templateHash,
    layoutHash: layout.layoutHash,
    ...(input.options?.jobId === undefined ? {} : { jobId: input.options.jobId }),
    runCount: printedRuns.length,
    ...(input.options?.meta ?? {}),
  }

  const title =
    input.options?.title ??
    `Cheque ${layout.templateId} v${String(layout.templateVersion)} — ${String(layout.runCount)} runs`

  const html = buildStandaloneDocument({
    title,
    lang: layout.locale.split('-')[0] ?? 'en',
    direction: layout.direction,
    css,
    body: body.join('\n'),
    meta,
  })

  const forbidden = findForbiddenMarkup(html)
  for (const violation of forbidden) {
    violations.push({
      code: 'PRINT_DOCUMENT_NOT_DATA_ONLY',
      severity: 'error',
      message: `print output is not data-only: ${violation.why} — near "${violation.snippet}"`,
      remediation: 'the reference artwork belongs to the preview layer only; remove it from the print path',
    })
  }
  if (violations.length > 0) {
    throw new PrintBlockedError(
      `refusing to emit a print document with ${String(violations.length)} safety violation(s)`,
      violations
    )
  }

  const bytes = utf8ByteLength(html)
  return Object.freeze({
    html,
    mimeType: 'text/html',
    encoding: 'utf-8',
    pageWidthMm: layout.paper.widthMm,
    pageHeightMm: layout.paper.heightMm,
    marginMm: input.options?.marginMm ?? 0,
    runCount: printedRuns.filter((run) => run.text.trim() !== '').length,
    layoutHash: layout.layoutHash,
    templateId: layout.templateId,
    templateVersion: layout.templateVersion,
    bytes,
    hash: hashCanonical({ bytes, html }),
  })
}

function fallbackLine(run: PlacedGlyphRun): { text: string; xMm: number; yMm: number; widthMm: number; heightMm: number } {
  return {
    text: run.text,
    xMm: run.xMm,
    yMm: run.yMm,
    widthMm: run.widthMm,
    heightMm: run.heightMm,
  }
}

function languageOf(run: PlacedGlyphRun): string {
  return run.direction === 'rtl' ? 'ar' : 'en'
}

function sanitizeStack(fontFamily: string): string {
  // A template font name is untrusted input: strip anything that could break out of the
  // declaration, then keep a generic family so the printer still has a substitution.
  const cleaned = escapeCssIdent(fontFamily)
  return cleaned === '' ? 'serif' : `"${cleaned}", serif`
}

/**
 * Where a transformed point lands, exposed for the preview overlay: the designer shows the operator
 * BOTH the template position and where this printer will actually put it.
 */
export function printedPositionOf(
  layout: PrintLayout,
  fieldId: string,
  profile: PrinterProfile,
  calibration?: PrinterCalibration | null
): { xMm: number; yMm: number } | null {
  const run = layout.runs.find((candidate) => candidate.fieldId === fieldId)
  if (run === undefined) return null
  const transformed = transformPoint({ xMm: run.xMm, yMm: run.yMm }, { profile, calibration: calibration ?? null })
  return { xMm: roundMm(transformed.xMm), yMm: roundMm(transformed.yMm) }
}
