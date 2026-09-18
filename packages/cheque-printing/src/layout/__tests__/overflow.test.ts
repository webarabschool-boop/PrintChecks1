import { describe, expect, it } from 'vitest'
import { measureTextMm } from '../measure'
import { roundMm } from '../../geometry/units'
import { createChequePrintData, type ChequePrintData } from '../../printdata'
import {
  createBankChequeTemplate,
  type BankChequeTemplate,
  type CreateTemplateFieldInput,
  type TemplateField,
} from '../../template'
import { buildPrintLayout } from '../engine'
import type { PlacedGlyphRun } from '../types'

const style = { fontFamily: 'Times New Roman', fontSizePt: 12 }

function fieldWith(overrides: Partial<CreateTemplateFieldInput>): CreateTemplateFieldInput {
  return {
    id: 'payee',
    key: 'payee',
    label: 'Pay to the order of',
    role: 'value',
    xMm: 10,
    yMm: 30,
    widthMm: 110,
    heightMm: 8,
    source: 'payeeName',
    ...style,
    ...overrides,
  }
}

function oneFieldTemplate(field: CreateTemplateFieldInput, extraFields: CreateTemplateFieldInput[] = []): BankChequeTemplate {
  return createBankChequeTemplate({
    id: 'overflow-fixture',
    bankId: 'bank:fixture',
    bankName: 'Fixture Bank',
    name: 'Overflow fixture',
    stockType: 'personal',
    paper: {
      widthMm: 200,
      heightMm: 90,
      orientation: 'landscape',
      bodyOriginMm: { xMm: 0, yMm: 0 },
      bodyWidthMm: 200,
      bodyHeightMm: 90,
    },
    fields: [field, ...extraFields],
  })
}

function layoutFor(field: CreateTemplateFieldInput, payeeName: string) {
  return buildPrintLayout({
    template: oneFieldTemplate(field),
    data: createChequePrintData({
      chequeNumber: '1',
      date: '2026-09-18',
      payeeName,
      amountDecimal: '10.00',
      currency: 'EGP',
    }),
  })
}

const run = (layout: { runs: readonly PlacedGlyphRun[] }): PlacedGlyphRun => layout.runs[0]!

describe('overflow policy — shrink', () => {
  const LONG = 'Crescent Trading Holdings International Limited'

  it('shrinks the font instead of crossing the pre-printed rule', () => {
    const layout = layoutFor(fieldWith({ overflow: 'shrink', widthMm: 40 }), LONG)
    const placed = run(layout)
    expect(placed.fontSizeShrunk).toBe(true)
    expect(placed.fontSizePt).toBeLessThan(12)
    expect(placed.fontSizePt).toBeGreaterThanOrEqual(roundMm(12 * 0.6 * 100) / 100 - 0.01)
    expect(layout.warnings.map((warning) => warning.code)).toContain('FIELD_OVERFLOW_SHRUNK')
    expect(layout.blocked).toBe(false)
    // The shrunk line must actually fit the box now.
    const shrunkStyle = {
      fontFamily: placed.fontFamily,
      fontSizePt: placed.fontSizePt,
      fontWeight: placed.fontWeight,
      fontStyle: placed.fontStyle,
      lineHeight: placed.lineHeight,
      isMicr: false,
      direction: placed.direction,
    } as const
    expect(measureTextMm(placed.sourceText, shrunkStyle)).toBeLessThanOrEqual(placed.widthMm + 0.05)
  })

  it('clips and warns when even the floor size is too wide, rather than shrinking to nothing', () => {
    const layout = layoutFor(fieldWith({ overflow: 'shrink', widthMm: 8 }), LONG)
    const placed = run(layout)
    expect(layout.warnings.map((warning) => warning.code)).toContain('FIELD_OVERFLOW_CLIPPED')
    expect(placed.truncated).toBe(true)
    expect(placed.fontSizePt).toBeGreaterThan(0)
    expect(layout.blocked).toBe(false)
  })

  it('leaves a short value at the authored size', () => {
    const layout = layoutFor(fieldWith({ overflow: 'shrink' }), 'Acme')
    expect(run(layout).fontSizeShrunk).toBe(false)
    expect(layout.warnings.filter((warning) => warning.code.startsWith('FIELD_OVERFLOW'))).toEqual([])
    expect(layout.blocked).toBe(false)
  })
})

describe('overflow policy — wrap', () => {
  it('wraps onto as many lines as the box can hold, inside the box', () => {
    const LONG = 'Crescent Trading Holdings International Limited'
    const layout = layoutFor(fieldWith({ overflow: 'wrap', widthMm: 40, heightMm: 24, alignment: { horizontal: 'left', vertical: 'top' } }), LONG)
    const placed = run(layout)
    expect(placed.lines.length).toBeGreaterThan(1)
    const lineHeight = placed.lines[1]!.yMm - placed.lines[0]!.yMm
    expect(lineHeight).toBeGreaterThan(0)
    const lastLine = placed.lines[placed.lines.length - 1]!
    expect(roundMm(lastLine.yMm + lastLine.heightMm)).toBeLessThanOrEqual(roundMm(placed.yMm + placed.heightMm))
    for (const line of placed.lines) {
      expect(line.widthMm).toBeLessThanOrEqual(placed.widthMm + 0.05)
    }
    // Re-joining the lines must reproduce the payee: wrapping is layout, not editing.
    expect(placed.sourceText.split('\n').join(' ')).toBe(LONG)
  })

  it('reports a wrapped block that is taller than the field', () => {
    const layout = layoutFor(fieldWith({ overflow: 'wrap', widthMm: 30, heightMm: 8 }), 'Crescent Trading Holdings International Limited')
    expect(layout.warnings.map((warning) => warning.code)).toContain('FIELD_WRAP_OVERFLOW')
    expect(run(layout).lines.length).toBeGreaterThan(1)
  })

  it('bottom-aligns a wrapped block against the pre-printed rule', () => {
    const long = 'Crescent Trading Holdings International Limited'
    const bottom = run(layoutFor(fieldWith({ overflow: 'wrap', widthMm: 40, heightMm: 30, alignment: { horizontal: 'left', vertical: 'bottom' } }), long))
    const top = run(layoutFor(fieldWith({ overflow: 'wrap', widthMm: 40, heightMm: 30, alignment: { horizontal: 'left', vertical: 'top' } }), long))
    expect(bottom.lines.length).toBe(top.lines.length)
    const bottomLast = bottom.lines[bottom.lines.length - 1]!
    const topLast = top.lines[top.lines.length - 1]!
    expect(bottomLast.yMm).toBeGreaterThan(topLast.yMm)
  })
})

describe('overflow policy — clip and error', () => {
  it('clip warns with the measured excess and prints as authored', () => {
    const layout = layoutFor(fieldWith({ overflow: 'clip', widthMm: 20 }), 'Crescent Trading Holdings')
    const placed = run(layout)
    const warning = layout.warnings.find((entry) => entry.code === 'FIELD_OVERFLOW_CLIPPED')
    expect(warning?.message).toContain('wider than the field')
    expect(placed.fontSizeShrunk).toBe(false)
    expect(placed.fontSizePt).toBe(12)
    expect(layout.blocked).toBe(false)
  })

  it('error blocks the print, which is what an amount box needs', () => {
    const layout = layoutFor(fieldWith({ overflow: 'error', widthMm: 10, label: 'Amount' }), 'Crescent Trading Holdings International')
    expect(layout.warnings.map((warning) => warning.code)).toContain('FIELD_OVERFLOW_BLOCKED')
    expect(layout.blocked).toBe(true)
  })

  it('does not report an overflow at all when the value fits', () => {
    expect(layoutFor(fieldWith({ overflow: 'error', widthMm: 150 }), 'Acme').blocked).toBe(false)
  })
})

describe('maxChars', () => {
  it('drops the tail rather than the bank’s rule, and says so', () => {
    const layout = layoutFor(fieldWith({ maxChars: 12, overflow: 'error', widthMm: 180 }), 'Crescent Trading Holdings International')
    const placed = run(layout)
    expect(placed.sourceText).toBe('Crescent Tra')
    expect(placed.truncated).toBe(true)
    expect(layout.warnings.map((warning) => warning.code)).toContain('FIELD_CHARS_TRUNCATED')
    // Truncation happened before measuring, so "error" no longer fires.
    expect(layout.blocked).toBe(false)
  })

  it('leaves a short value untouched', () => {
    expect(run(layoutFor(fieldWith({ maxChars: 50 }), 'Acme')).truncated).toBe(false)
  })
})

describe('run ordering and geometry', () => {
  it('sorts by zIndex then id, which is what makes the hash order-independent', () => {
    const templateFields: CreateTemplateFieldInput[] = [
      fieldWith({ id: 'z3', zIndex: 3, key: 'amountNumeric', source: 'amountDecimal', widthMm: 40, xMm: 130, label: 'Amount' }),
      fieldWith({ id: 'b1', zIndex: 1, xMm: 10, yMm: 70, widthMm: 100, heightMm: 6, key: 'memo', source: 'memo', label: 'Memo' }),
      fieldWith({ id: 'a1', zIndex: 1, xMm: 10, yMm: 10, widthMm: 100, heightMm: 6, key: 'chequeNumber', source: 'chequeNumber', label: 'Number' }),
    ]
    const template = createBankChequeTemplate({
      id: 'ordering',
      bankId: 'bank:fixture',
      bankName: 'Fixture Bank',
      name: 'Ordering fixture',
      stockType: 'personal',
      paper: { widthMm: 200, heightMm: 90, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 200, bodyHeightMm: 90 },
      fields: templateFields,
    })
    const data: ChequePrintData = createChequePrintData({
      chequeNumber: '7',
      date: '2026-09-18',
      payeeName: 'Acme',
      amountDecimal: '10.00',
      currency: 'EGP',
      memo: 'rent',
    })
    const layout = buildPrintLayout({ template, data })
    expect(layout.runs.map((entry) => entry.fieldId)).toEqual(['a1', 'b1', 'z3'])
  })

  it('carries the typography through unchanged, so the renderer needs no template', () => {
    const placed = run(layoutFor(fieldWith({ fontWeight: 600, fontStyle: 'italic', lineHeight: 1.4, letterSpacingPt: 0.4 }), 'Acme'))
    expect(placed.fontFamily).toBe('Times New Roman')
    expect(placed.fontWeight).toBe(600)
    expect(placed.fontStyle).toBe('italic')
    expect(placed.lineHeight).toBe(1.4)
    expect(placed.letterSpacingPt).toBe(0.4)
    expect(placed.rotationDeg).toBe(0)
    expect(placed.isPrinted).toBe(true)
    expect(placed.isMicr).toBe(false)
  })

  it('keeps the field box as the run box, and the line inside it', () => {
    const placed = run(layoutFor(fieldWith({ widthMm: 100, heightMm: 8, alignment: { horizontal: 'center', vertical: 'middle' } }), 'Acme'))
    expect(placed.widthMm).toBe(100)
    expect(placed.heightMm).toBe(8)
    const line = placed.lines[0]!
    expect(line.xMm).toBeGreaterThan(placed.xMm)
    expect(roundMm(line.xMm + line.widthMm)).toBeLessThan(roundMm(placed.xMm + placed.widthMm))
    expect(line.yMm).toBe(placed.yMm)
  })

  it('applies a declared rotation so the renderer can counter-rotate it', () => {
    const placed = run(layoutFor(fieldWith({ rotationDeg: 90 }), 'Acme'))
    expect(placed.rotationDeg).toBe(90)
  })

  it('respects a bottom-left origin template, because some banks measure from the MICR band up', () => {
    const bottomLeft = createBankChequeTemplate({
      id: 'bottom-left',
      bankId: 'bank:fixture',
      bankName: 'Fixture Bank',
      name: 'Bottom-left fixture',
      stockType: 'personal',
      origin: 'bottom-left',
      paper: { widthMm: 200, heightMm: 90, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 200, bodyHeightMm: 90 },
      fields: [fieldWith({ yMm: 10 }) as TemplateField],
    })
    const layout = buildPrintLayout({ template: bottomLeft, data: createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '1.00', currency: 'EGP' }) })
    const placed = run(layout)
    // 90mm sheet − 10mm from the bottom − 8mm tall = 72mm from the top.
    expect(placed.yMm).toBe(72)
  })
})
