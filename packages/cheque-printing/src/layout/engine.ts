/**
 * The layout engine — `buildPrintLayout(data, template) → PrintLayout`.
 *
 * Pure, synchronous, no DOM, no clock, no randomness (§8.2). The same data and the same template
 * version produce the same runs and therefore the same `layoutHash` on every machine, which is what
 * lets a print record pin a layout and reproduce it later (rule A4).
 *
 * Four things happen here and nothing else:
 *   1. map each template field to a value (field mapping + format directives + amount-in-words port);
 *   2. resolve direction, so RTL stock and mixed-script content are decided at layout time, not by
 *      the browser at print time;
 *   3. apply the field's overflow policy and measure the result;
 *   4. report — collisions, out-of-bounds, empty required values, and everything the stock already
 *      owns and that this engine therefore refuses to print (rule T3).
 */

import { hashCanonical } from '../canonical/hash'
import { roundMm, rectIntersectionAreaMm2, rectsOverlap } from '../geometry/units'
import { AmountInWordsError } from '../errors'
import {
  analyseText,
  applyBidiIsolation,
  resolveFieldDirection,
  stripBidiControls,
} from '../printdata/bidi'
import { resolveFieldText } from '../printdata/formats'
import {
  PREPRINTED_SUPPRESSIONS,
  isKnownFieldKey,
  type BankChequeTemplate,
  type ChequeDataSource,
  type ChequeFieldKey,
  type TemplateField,
} from '../template/types'
import { fieldRectOnSheet, bodyRectOnSheet } from '../template/geometry'
import type { MmRect } from '../geometry/units'
import type { ChequePrintData } from '../printdata/types'
import type { AmountInWordsConverter } from '../ports/amountInWords'
import { fitTextToWidth, lineHeightMm, measureTextMm, MIN_FONT_SCALE } from './measure'
import { stackLines, wrapText } from './textWrap'
import type { LayoutWarning, PlacedGlyphRun, PrintLayout } from './types'

/** Default collision tolerance: below a quarter millimetre two rules read as one line. */
const DEFAULT_COLLISION_TOLERANCE_MM = 0.25

const DEFAULT_SOURCE_BY_KEY: Readonly<Partial<Record<ChequeFieldKey, ChequeDataSource>>> = {
  payee: 'payeeName',
  amountNumeric: 'amountDecimal',
  amountWords: 'amountWords',
  date: 'date',
  memo: 'memo',
  chequeNumber: 'chequeNumber',
  signature: 'signature',
  drawer: 'drawerName',
  drawerAddress: 'drawerAddress',
  bankInfo: 'bankName',
  accountNumber: 'accountNumber',
}

export interface BuildLayoutOptions {
  /** Injected port. Without it, words formats are a hard error rather than an invention. */
  readonly amountInWords?: AmountInWordsConverter
  readonly locale?: string
  readonly fractionStyle?: 'words' | 'numeric-fraction' | 'none'
  /** Preview keeps guide fields; the print document filters them out regardless. */
  readonly includeGuides?: boolean
  readonly collisionToleranceMm?: number
}

export interface BuildLayoutInput {
  readonly template: BankChequeTemplate
  readonly data: ChequePrintData
  readonly options?: BuildLayoutOptions
}

export function buildPrintLayout({ template, data, options = {} }: BuildLayoutInput): PrintLayout {
  const warnings: LayoutWarning[] = []
  const suppressedFields: string[] = []
  const runs: PlacedGlyphRun[] = []
  const guides: PlacedGlyphRun[] = []
  const locale = options.locale ?? data.locale ?? template.defaultLocale
  const tolerance = options.collisionToleranceMm ?? DEFAULT_COLLISION_TOLERANCE_MM
  const includeGuides = options.includeGuides ?? true

  const wordsContext =
    options.amountInWords === undefined
      ? undefined
      : {
          converter: options.amountInWords,
          locale,
          ...(options.fractionStyle === undefined ? {} : { fractionStyle: options.fractionStyle }),
        }

  const precomputedWords = data.amountWords ?? null
  let renderedWords: string | null = null

  const ordered = sortFieldsDeterministically(template.fields)

  for (const field of ordered) {
    if (field.isPrinted && field.typography.isMicr) {
      // §9: MICR encoding is not implemented, so a MICR-flagged printed field can only mean a
      // misunderstanding. Refuse it here rather than emit toner that a reader will mis-read.
      warnings.push({
        code: 'FIELD_MICR_NOT_PRINTABLE',
        severity: 'error',
        fieldId: field.id,
        message: `field "${field.id}" is flagged MICR and marked printable; this phase emits no MICR band`,
        remediation: 'set isPrinted: false — the band belongs to the bank or to a MICR device',
      })
      continue
    }

    const suppression = findPreprintedSuppression(template, field)
    if (suppression !== null) {
      suppressedFields.push(field.id)
      warnings.push({
        code: 'FIELD_SUPPRESSED_BY_PREPRINTED',
        severity: 'warning',
        fieldId: field.id,
        message: `"${field.label}" is not printed: ${suppression.reason}`,
        remediation: 'expected on pre-printed stock; delete the field if it is only noise',
      })
      continue
    }

    const source = field.source ?? DEFAULT_SOURCE_BY_KEY[field.key] ?? null
    const rawValue = resolveSourceValue(source, field, data)

    if (source === 'signature' && field.isPrinted) {
      warnings.push({
        code: 'FIELD_SIGNATURE_NOT_PRINTABLE',
        severity: 'error',
        fieldId: field.id,
        message: `field "${field.id}" is bound to the signature, which a human draws by hand on the stock`,
        remediation: 'make it a preview-only guide (isPrinted: false)',
      })
      continue
    }

    if (source === null && isKnownFieldKey(field.key) === false) {
      warnings.push({
        code: 'FIELD_UNRESOLVED_SOURCE',
        severity: 'error',
        fieldId: field.id,
        message: `field "${field.id}" (key "${field.key}") has no resolvable data source`,
        remediation: 'set source explicitly, with customKey when the source is "custom"',
      })
      continue
    }

    if (source === 'custom' && (field.customKey === undefined || field.customKey === '')) {
      // The publisher catches this, but a template imported from another tool can still arrive with
      // a custom source that names nothing to read. Refusing beats printing an empty box.
      warnings.push({
        code: 'FIELD_UNRESOLVED_SOURCE',
        severity: 'error',
        fieldId: field.id,
        message: `field "${field.id}" is mapped to the custom source without naming a customKey`,
        remediation: 'set customKey to the property name in the print data',
      })
      continue
    }

    let text: string
    try {
      text = resolveFieldText(
        field.format,
        rawValue,
        data,
        locale,
        wordsContext === undefined
          ? undefined
          : { ...wordsContext, uppercase: field.textTransform === 'uppercase' }
      )
    } catch (error) {
      if (error instanceof AmountInWordsError) {
        warnings.push({
          code: 'FIELD_WORDS_RENDER_FAILED',
          severity: 'error',
          fieldId: field.id,
          message: `amount-in-words could not be rendered for "${field.label}": ${error.message}`,
          remediation: 'inject an AmountInWordsConverter that supports this locale (the app wires the existing to-words adapter)',
        })
        text = ''
      } else {
        throw error
      }
    }

    if (field.format === 'amount-words-en' || field.format === 'amount-words-ar') {
      if (text.trim() === '' && wordsContext === undefined) {
        text = precomputedWords ?? ''
      }
      if (text.trim() !== '') {
        renderedWords = text
      }
    }

    // Emptiness is judged on the text that would actually land on the paper, not on the raw property:
    // a words line is rendered from the amount, so an empty `amountWords` on the cheque is not an
    // empty field — refusing there would reject the very cheques the words converter exists for.
    if (text.trim() === '' && field.isPrinted) {
      if (field.required === true) {
        warnings.push({
          code: 'REQUIRED_FIELD_EMPTY',
          severity: 'error',
          fieldId: field.id,
          message: `"${field.label}" is required by the template but the cheque supplies no value`,
          remediation: 'fill the field in, or remove it from the template',
        })
      } else {
        warnings.push({
          code: 'FIELD_VALUE_EMPTY',
          severity: 'warning',
          fieldId: field.id,
          message: `"${field.label}" has no value; nothing will be printed there`,
        })
      }
    }

    if (field.textTransform === 'uppercase' && field.format !== 'amount-words-en' && field.format !== 'amount-words-ar') {
      text = text.toUpperCase()
    }

    let truncated = false
    if (field.maxChars !== undefined && text.length > field.maxChars) {
      text = text.slice(0, field.maxChars)
      truncated = true
      warnings.push({
        code: 'FIELD_CHARS_TRUNCATED',
        severity: 'warning',
        fieldId: field.id,
        message: `"${field.label}" exceeds maxChars (${String(field.maxChars)}); the rest is dropped rather than printed over the bank's rule`,
        remediation: 'raise maxChars, shorten the value, or switch overflow to "shrink"',
      })
    }

    const rect = fieldRectOnSheet(template, field)
    const typography = field.typography
    const direction = resolveFieldDirection(text, typography.direction, template.defaultDirection, data.directionHint)
    const analysis = analyseText(text, template.defaultDirection)

    let fontSizePt = typography.fontSizePt
    let lines: string[] = [text]
    let fontSizeShrunk = false
    let overflowMm: number

    const textHeightFor = (size: number) => {
      const factor = size / typography.fontSizePt
      return roundMm(lineHeightMm(typography) * factor)
    }

    const availableWidth = roundMm(rect.widthMm)
    const measuredWidth = measureTextMm(text, typography)

    if (text.trim() !== '' && measuredWidth > availableWidth) {
      switch (field.overflow) {
        case 'shrink': {
          const fit = fitTextToWidth(text, typography, availableWidth)
          fontSizePt = fit.fontSizePt
          fontSizeShrunk = fit.scale < 0.999
          if (!fit.fits) {
            overflowMm = roundMm(fit.requiredWidthMm - availableWidth)
            warnings.push({
              code: 'FIELD_OVERFLOW_CLIPPED',
              severity: 'warning',
              fieldId: field.id,
              message: `"${field.label}" still exceeds the field by ${String(overflowMm)}mm after shrinking to the ${String(MIN_FONT_SCALE * 100)}% floor`,
              remediation: 'widen the field, shorten the value, or reduce maxChars',
            })
            truncated = true
          } else {
            warnings.push({
              code: 'FIELD_OVERFLOW_SHRUNK',
              severity: 'warning',
              fieldId: field.id,
              message: `"${field.label}" was shrunk to ${String(fontSizePt)}pt to fit ${String(availableWidth)}mm`,
              remediation: 'check the preview: a shrunken value looks different from the rest of the sheet',
            })
          }
          break
        }
        case 'wrap': {
          const wrapped = wrapText(text, typography, availableWidth)
          lines = wrapped.lines
          const lineHeight = textHeightFor(fontSizePt)
          const stacked = stackLines({
            boxTopMm: 0,
            boxHeightMm: rect.heightMm,
            lineHeightMm: lineHeight,
            lineCount: lines.length,
            vertical: field.alignment.vertical,
          })
          overflowMm = stacked.overflowMm
          if (wrapped.hardBroken) {
            warnings.push({
              code: 'FIELD_WRAP_OVERFLOW',
              severity: 'warning',
              fieldId: field.id,
              message: `"${field.label}" contains a word wider than the field and was hard-broken`,
              remediation: 'a cheque line should not need this; consider "shrink" or a wider field',
            })
          }
          if (overflowMm > 0) {
            warnings.push({
              code: 'FIELD_WRAP_OVERFLOW',
              severity: 'warning',
              fieldId: field.id,
              message: `"${field.label}" wraps to ${String(lines.length)} lines, which is ${String(overflowMm)}mm taller than the field`,
              remediation: 'raise the field height, use fewer words, or change overflow to "clip"',
            })
          }
          break
        }
        case 'clip': {
          overflowMm = roundMm(measuredWidth - availableWidth)
          warnings.push({
            code: 'FIELD_OVERFLOW_CLIPPED',
            severity: 'warning',
            fieldId: field.id,
            message: `"${field.label}" is ${String(overflowMm)}mm wider than the field and will be clipped by the field box`,
            remediation: 'this is a deliberate policy for short-notice fields (e.g. a stub); confirm it looks right',
          })
          break
        }
        case 'error':
        default: {
          warnings.push({
            code: 'FIELD_OVERFLOW_BLOCKED',
            severity: 'error',
            fieldId: field.id,
            message: `"${field.label}" is ${String(roundMm(measuredWidth - availableWidth))}mm too wide and its overflow policy is "error"`,
            remediation: 'shorten the value, widen the field, or choose "shrink" if a smaller face is acceptable',
          })
          break
        }
      }
    }

    // Bidi: inside an RTL line, opposite-direction runs are isolated so a Latin cheque number or
    // amount inside an Arabic sentence keeps its order on the paper.
    const isolatedLines = lines.map((line) => applyBidiIsolation(line, direction))
    const printText = isolatedLines.join('\n')

    const lineHeight = textHeightFor(fontSizePt)
    const blockOffsetMm = lineBlockOffset(field, rect.heightMm, lines.length, lineHeight)
    const lineRects = lines.map((line, index) => {
      const measuredLine = measureTextMm(line, { ...typography, fontSizePt })
      const lineWidth = roundMm(Math.min(measuredLine, rect.widthMm))
      // Horizontal placement is resolved here, once, so the preview and the printer receive the
      // same x from the same rule. A right-aligned amount box is geometry, not a CSS accident.
      const innerOffset = alignOffsetMm(field.alignment.horizontal, rect.widthMm, lineWidth)
      return {
        text: isolatedLines[index] ?? line,
        xMm: roundMm(rect.xMm + innerOffset),
        yMm: roundMm(rect.yMm + blockOffsetMm + index * lineHeight),
        widthMm: lineWidth,
        heightMm: roundMm(lineHeight),
      }
    })

    const run: PlacedGlyphRun = {
      fieldId: field.id,
      fieldKey: field.key,
      role: field.role,
      label: field.label,
      text: printText,
      sourceText: stripBidiControls(printText),
      xMm: rect.xMm,
      yMm: rect.yMm,
      widthMm: rect.widthMm,
      heightMm: rect.heightMm,
      fontFamily: typography.fontFamily,
      fontSizePt,
      fontWeight: typography.fontWeight,
      fontStyle: typography.fontStyle,
      ...(typography.letterSpacingPt === undefined ? {} : { letterSpacingPt: typography.letterSpacingPt }),
      lineHeight: roundMm(typography.lineHeight ?? 1.15),
      alignH: field.alignment.horizontal,
      alignV: field.alignment.vertical,
      isMicr: typography.isMicr,
      rotationDeg: field.rotationDeg ?? 0,
      zIndex: field.zIndex,
      direction,
      isMixedDirection: analysis.isMixed,
      segments: analysis.segments,
      lines: lineRects.map((line) => ({ ...line, text: line.text })),
      format: field.format,
      overflowPolicy: field.overflow,
      truncated,
      fontSizeShrunk,
      isPrinted: field.isPrinted,
    }

    if (rect.xMm < 0 || rect.yMm < 0 || rect.xMm + rect.widthMm > template.paper.widthMm + 0.001 || rect.yMm + rect.heightMm > template.paper.heightMm + 0.001) {
      warnings.push({
        code: 'FIELD_OUTSIDE_PAPER',
        severity: 'error',
        fieldId: field.id,
        message: `field "${field.id}" resolves outside the ${String(template.paper.widthMm)}x${String(template.paper.heightMm)}mm sheet`,
        remediation: 'check bodyOriginMm and the field coordinates',
      })
    } else {
      const body = bodyRectOnSheet(template)
      if (!insideRect(body, rect)) {
        warnings.push({
          code: 'FIELD_OUTSIDE_BODY',
          severity: 'warning',
          fieldId: field.id,
          message: `field "${field.id}" prints outside the declared cheque body (a stub or footer may be intentional)`,
        })
      }
    }

    if (field.isPrinted) runs.push(run)
    else if (includeGuides) guides.push(run)
  }

  detectCollisions(runs, template, warnings, tolerance)
  checkAmountConsistency(data, renderedWords, warnings, options)
  checkChequeNumberPresence(template, warnings)

  const sorted = [...runs].sort(
    (a, b) => a.zIndex - b.zIndex || a.fieldId.localeCompare(b.fieldId)
  )
  const sortedGuides = [...guides].sort(
    (a, b) => a.zIndex - b.zIndex || a.fieldId.localeCompare(b.fieldId)
  )

  const blocked = warnings.some((warning) => warning.severity === 'error')

  const withoutHash = {
    templateId: template.id,
    templateVersion: template.version,
    templateHash: template.templateHash,
    paper: {
      widthMm: template.paper.widthMm,
      heightMm: template.paper.heightMm,
      orientation: template.paper.orientation,
    },
    runs: sorted.map(toHashableRun),
    direction: template.defaultDirection,
    locale,
  }

  return Object.freeze({
    templateId: template.id,
    templateVersion: template.version,
    templateHash: template.templateHash,
    paper: withoutHash.paper,
    runs: Object.freeze(sorted),
    guides: Object.freeze(sortedGuides),
    suppressedFields: Object.freeze(suppressedFields),
    warnings: Object.freeze(warnings),
    blocked,
    direction: template.defaultDirection,
    locale,
    runCount: sorted.length,
    layoutHash: hashCanonical(withoutHash),
  })
}

function sortFieldsDeterministically(fields: readonly TemplateField[]): TemplateField[] {
  // zIndex first (paint order), then id so an author reordering the table cannot change the hash.
  return [...fields].sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
}

function findPreprintedSuppression(template: BankChequeTemplate, field: TemplateField) {
  if (!field.isPrinted) return null
  return (
    PREPRINTED_SUPPRESSIONS.find(
      (rule) =>
        template.preprinted[rule.flag] &&
        (rule.keys.length === 0 || rule.keys.includes(field.key)) &&
        rule.roles.includes(field.role)
    ) ?? null
  )
}

function resolveSourceValue(
  source: ChequeDataSource | null,
  field: TemplateField,
  data: ChequePrintData
): string {
  switch (source) {
    case 'chequeNumber':
      return data.chequeNumber
    case 'date':
      return data.date
    case 'payeeName':
      return data.payeeName
    case 'amountDecimal':
      return data.amountDecimal
    case 'amountWords':
      return data.amountWords ?? ''
    case 'currency':
      return data.currency
    case 'memo':
      return data.memo ?? ''
    case 'reference':
      return data.reference ?? ''
    case 'drawerName':
      return data.drawerName ?? ''
    case 'drawerAddress':
      return data.drawerAddress ?? ''
    case 'bankName':
      return data.bankName ?? ''
    case 'accountNumber':
      return data.accountNumber ?? ''
    case 'signature':
      return ''
    case 'custom': {
      const key = field.customKey
      if (key === undefined || key === '') return ''
      return data.custom?.[key] ?? ''
    }
    case null:
    default:
      return ''
  }
}

function lineBlockOffset(
  field: TemplateField,
  boxHeightMm: number,
  lineCount: number,
  lineHeightMm: number
): number {
  if (lineCount <= 1) return 0
  const blockHeight = roundMm(lineHeightMm * lineCount)
  switch (field.alignment.vertical) {
    case 'middle':
      return roundMm((boxHeightMm - blockHeight) / 2)
    case 'bottom':
    case 'baseline':
      return roundMm(boxHeightMm - blockHeight)
    case 'top':
    default:
      return 0
  }
}

/** Where a line sits inside its field box, given the box's horizontal alignment. */
function alignOffsetMm(
  align: 'left' | 'center' | 'right',
  boxWidthMm: number,
  lineWidthMm: number
): number {
  const slack = roundMm(Math.max(0, boxWidthMm - lineWidthMm))
  if (slack === 0) return 0
  switch (align) {
    case 'right':
      return slack
    case 'center':
      return roundMm(slack / 2)
    case 'left':
    default:
      return 0
  }
}

function insideRect(outer: MmRect, inner: MmRect): boolean {
  return (
    inner.xMm >= outer.xMm - 0.001 &&
    inner.yMm >= outer.yMm - 0.001 &&
    inner.xMm + inner.widthMm <= outer.xMm + outer.widthMm + 0.001 &&
    inner.yMm + inner.heightMm <= outer.yMm + outer.heightMm + 0.001
  )
}

function detectCollisions(
  runs: readonly PlacedGlyphRun[],
  template: BankChequeTemplate,
  warnings: LayoutWarning[],
  tolerance: number
): void {
  for (let i = 0; i < runs.length; i += 1) {
    const a = runs[i]
    if (a === undefined) continue
    for (let j = i + 1; j < runs.length; j += 1) {
      const b = runs[j]
      if (b === undefined) continue
      if (!rectsOverlap(a, b, tolerance)) continue
      const area = rectIntersectionAreaMm2(a, b)
      // Two runs sharing space is only an emergency when both carry ink.
      if (a.text.trim() === '' || b.text.trim() === '') continue
      warnings.push({
        code: 'FIELD_COLLISION',
        severity: 'error',
        fieldId: a.fieldId,
        message: `fields "${a.fieldId}" and "${b.fieldId}" overlap by ${String(area)}mm² on ${template.name}`,
        remediation: 'move one field; overlapping toner makes a cheque figure unreadable and is a fraud surface',
      })
    }
  }
}

/**
 * The words line is the value a bank pays when figures and words disagree, so a template that gets
 * both from two different sources is worth flagging. When the caller pre-computed `amountWords` (the
 * legacy store does) and the engine renders its own from the amount, a divergence is reported.
 */
function checkAmountConsistency(
  data: ChequePrintData,
  renderedWords: string | null,
  warnings: LayoutWarning[],
  options: BuildLayoutOptions
): void {
  if (renderedWords === null || data.amountWords === null || data.amountWords === undefined) return
  if (data.amountWords.trim() === '') return
  const normalized = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized(data.amountWords) === normalized(renderedWords)) return
  if (options.amountInWords === undefined) return
  warnings.push({
    code: 'AMOUNT_NUMBER_WORDS_MISMATCH',
    severity: 'warning',
    message:
      `the supplied words line ("${stripBidiControls(data.amountWords).slice(0, 48)}") does not match the words ` +
      `rendered from the amount ("${stripBidiControls(renderedWords).slice(0, 48)}"). The words govern — check before printing`,
    remediation: 'let the engine render the words line, or correct the stored amount',
  })
}

function checkChequeNumberPresence(template: BankChequeTemplate, warnings: LayoutWarning[]): void {
  const hasNumberField = template.fields.some((field) => field.key === 'chequeNumber' && field.isPrinted)
  if (hasNumberField) return
  warnings.push({
    code: 'CHEQUE_NUMBER_NOT_PRINTED',
    severity: 'warning',
    message: 'no printed field carries the cheque number — normal for pre-numbered stock, and a defect if this stock is unnumbered',
    remediation: 'confirm the stock is pre-numbered; if it is not, add a chequeNumber field',
  })
}

function toHashableRun(run: PlacedGlyphRun): Record<string, unknown> {
  return {
    fieldId: run.fieldId,
    fieldKey: run.fieldKey,
    role: run.role,
    text: run.text,
    xMm: run.xMm,
    yMm: run.yMm,
    widthMm: run.widthMm,
    heightMm: run.heightMm,
    fontFamily: run.fontFamily,
    fontSizePt: run.fontSizePt,
    fontWeight: run.fontWeight,
    fontStyle: run.fontStyle,
    letterSpacingPt: run.letterSpacingPt ?? 0,
    alignH: run.alignH,
    alignV: run.alignV,
    direction: run.direction,
    rotationDeg: run.rotationDeg,
    zIndex: run.zIndex,
    lines: run.lines.map((line) => ({
      text: line.text,
      xMm: line.xMm,
      yMm: line.yMm,
      widthMm: line.widthMm,
      heightMm: line.heightMm,
    })),
  }
}
