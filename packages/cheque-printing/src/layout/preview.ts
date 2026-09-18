/**
 * Preview geometry — the only place a pixel is ever produced, and a one-way street.
 *
 * The UI draws a layout at a declared DPI (default 96 CSS px/inch, i.e. browser "100%"). Preview is
 * *derived from* print geometry (rule T5): nothing here is ever fed back, and the function is pure
 * so a screenshot test can assert a specific pixel position without a browser.
 */

import { mmToPx, roundMm, type MmExtent } from '../geometry/units'
import type { BankChequeTemplate } from '../template/types'
import { bodyRectOnSheet, fieldRectOnSheet } from '../template/geometry'
import type { PlacedGlyphRun, PrintLayout } from './types'

export interface PreviewBox {
  readonly leftPx: number
  readonly topPx: number
  readonly widthPx: number
  readonly heightPx: number
}

export interface PreviewRun extends PreviewBox {
  readonly fieldId: string
  readonly text: string
  readonly fontSizePx: number
  readonly fontFamily: string
  readonly fontWeight: number
  readonly fontStyle: 'normal' | 'italic'
  readonly letterSpacingPx: number
  readonly alignH: PlacedGlyphRun['alignH']
  readonly alignV: PlacedGlyphRun['alignV']
  readonly direction: 'ltr' | 'rtl'
  readonly rotationDeg: number
  readonly zIndex: number
  readonly isGuide: boolean
  readonly isMicr: boolean
}

export interface PreviewLayout {
  readonly dpi: number
  readonly scaleLabel: string
  readonly sheet: PreviewBox & MmExtent
  readonly body: PreviewBox
  readonly runs: readonly PreviewRun[]
}

export interface PreviewOptions {
  readonly dpi?: number
  /** Draw guides (preview-only fields) — always true for a designer, ignored for print. */
  readonly includeGuides?: boolean
  readonly zoom?: number
}

export function previewScaleLabel(dpi: number, zoom = 1): string {
  return `${String(dpi)} dpi @ ${String(Math.round(zoom * 100))}%`
}

export function toPreviewLayout(
  layout: PrintLayout,
  template: BankChequeTemplate,
  options: PreviewOptions = {}
): PreviewLayout {
  const dpi = options.dpi ?? 96
  const zoom = options.zoom ?? 1
  const includeGuides = options.includeGuides ?? true
  const runs = includeGuides ? [...layout.runs, ...layout.guides] : [...layout.runs]

  return {
    dpi,
    scaleLabel: previewScaleLabel(dpi, zoom),
    sheet: {
      ...toPreviewBox(
        { xMm: 0, yMm: 0, widthMm: template.paper.widthMm, heightMm: template.paper.heightMm },
        dpi,
        zoom
      ),
      widthMm: template.paper.widthMm,
      heightMm: template.paper.heightMm,
    },
    body: toPreviewBox(bodyRectOnSheet(template), dpi, zoom),
    runs: runs.map((run) => ({
      ...toPreviewBox(
        { xMm: run.xMm, yMm: run.yMm, widthMm: run.widthMm, heightMm: run.heightMm },
        dpi,
        zoom
      ),
      fieldId: run.fieldId,
      text: run.sourceText,
      fontSizePx: roundMm(mmToPx((run.fontSizePt * 25.4) / 72, dpi) * zoom),
      fontFamily: run.fontFamily,
      fontWeight: run.fontWeight,
      fontStyle: run.fontStyle,
      letterSpacingPx: roundMm(mmToPx(((run.letterSpacingPt ?? 0) * 25.4) / 72, dpi) * zoom),
      alignH: run.alignH,
      alignV: run.alignV,
      direction: run.direction,
      rotationDeg: run.rotationDeg,
      zIndex: run.zIndex,
      isGuide: !run.isPrinted,
      isMicr: run.isMicr,
    })),
  }
}

function toPreviewBox(rect: { xMm: number; yMm: number; widthMm: number; heightMm: number }, dpi: number, zoom: number): PreviewBox {
  return {
    leftPx: roundMm(mmToPx(rect.xMm, dpi) * zoom),
    topPx: roundMm(mmToPx(rect.yMm, dpi) * zoom),
    widthPx: roundMm(mmToPx(rect.widthMm, dpi) * zoom),
    heightPx: roundMm(mmToPx(rect.heightMm, dpi) * zoom),
  }
}

/** A single field's box, for the drag/resize handles in the designer. */
export function previewFieldBox(
  template: BankChequeTemplate,
  fieldId: string,
  options: PreviewOptions = {}
): PreviewBox | null {
  const dpi = options.dpi ?? 96
  const zoom = options.zoom ?? 1
  const field = template.fields.find((candidate) => candidate.id === fieldId)
  if (field === undefined) return null
  return toPreviewBox(fieldRectOnSheet(template, field), dpi, zoom)
}
