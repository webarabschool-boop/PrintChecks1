/**
 * The layout result — the contract between "what the template says" and "what the printer does".
 *
 * A `PrintLayout` is a resolved, ordered, unit-complete description of the ink that must land on the
 * sheet. It is a pure function of `(cheque data, template version)` — the printer profile and
 * calibration are NOT folded in, so the same layout can be sent to two printers (each with its own
 * transform) and still be recognisably the same print. That separation is what makes
 * `layoutHash` a meaningful thing to pin in a record.
 */

import type { BidiSegment } from '../printdata/bidi'
import type { HorizontalAlignment, VerticalAlignment, TemplateFormat, FieldRole, ChequeFieldKey } from '../template/types'

export interface LayoutLine {
  readonly text: string
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number
}

export interface PlacedGlyphRun {
  readonly fieldId: string
  readonly fieldKey: ChequeFieldKey
  readonly role: FieldRole
  readonly label: string

  /** The exact string to print, including any bidi isolates. */
  readonly text: string
  /** The same text with bidi control characters removed — for display, diffs and audit records. */
  readonly sourceText: string

  /** Millimetres from the top-left of the SHEET (body offset already applied). */
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number

  readonly fontFamily: string
  readonly fontSizePt: number
  readonly fontWeight: number
  readonly fontStyle: 'normal' | 'italic'
  readonly letterSpacingPt?: number
  readonly lineHeight: number

  readonly alignH: HorizontalAlignment
  readonly alignV: VerticalAlignment

  readonly isMicr: boolean
  readonly rotationDeg: number
  readonly zIndex: number

  readonly direction: 'ltr' | 'rtl'
  readonly isMixedDirection: boolean
  readonly segments: readonly BidiSegment[]
  readonly lines: readonly LayoutLine[]

  readonly format?: TemplateFormat
  readonly overflowPolicy: 'shrink' | 'wrap' | 'clip' | 'error'
  /** True when the value was shortened to fit or to respect `maxChars`. */
  readonly truncated: boolean
  readonly fontSizeShrunk: boolean
  /** Preview-only runs (guide fields) — never rendered into a print document. */
  readonly isPrinted: boolean
}

export type LayoutWarningCode =
  | 'FIELD_SUPPRESSED_BY_PREPRINTED'
  | 'FIELD_VALUE_EMPTY'
  | 'REQUIRED_FIELD_EMPTY'
  | 'FIELD_OVERFLOW_SHRUNK'
  | 'FIELD_OVERFLOW_CLIPPED'
  | 'FIELD_OVERFLOW_BLOCKED'
  | 'FIELD_WRAP_OVERFLOW'
  | 'FIELD_CHARS_TRUNCATED'
  | 'FIELD_COLLISION'
  | 'FIELD_OUTSIDE_PAPER'
  | 'FIELD_OUTSIDE_BODY'
  | 'FIELD_UNRESOLVED_SOURCE'
  | 'FIELD_SIGNATURE_NOT_PRINTABLE'
  | 'FIELD_MICR_NOT_PRINTABLE'
  | 'FIELD_WORDS_RENDER_FAILED'
  | 'AMOUNT_NUMBER_WORDS_MISMATCH'
  | 'CHEQUE_NUMBER_NOT_PRINTED'

export interface LayoutWarning {
  readonly code: LayoutWarningCode
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly fieldId?: string
  readonly remediation?: string
}

export interface PrintLayoutPaper {
  readonly widthMm: number
  readonly heightMm: number
  readonly orientation: 'portrait' | 'landscape'
}

export interface PrintLayout {
  readonly templateId: string
  readonly templateVersion: number
  readonly templateHash: string
  readonly paper: PrintLayoutPaper
  /** Ink that goes on the paper, in paint order. */
  readonly runs: readonly PlacedGlyphRun[]
  /** Preview-only boxes: guides, MICR band area, signature area. Never printed (rule T5). */
  readonly guides: readonly PlacedGlyphRun[]
  /** Fields deliberately not emitted because the stock already carries them (rule T3). */
  readonly suppressedFields: readonly string[]
  readonly warnings: readonly LayoutWarning[]
  readonly blocked: boolean
  readonly direction: 'ltr' | 'rtl'
  readonly locale: string
  readonly runCount: number
  /** Canonical identity of this exact geometry. Pinned by the print record (rule A4). */
  readonly layoutHash: string
}
