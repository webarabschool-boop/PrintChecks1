import { describe, expect, it } from 'vitest'
import { roundMm } from '../../geometry/units'
import { buildPrintLayout } from '../../layout/engine'
import { createChequePrintData } from '../../printdata'
import { createBankChequeTemplate, type BankChequeTemplate } from '../../template'
import { createPrinterCalibration } from '../calibration'
import { createPrinterProfile } from '../profile'
import { buildRegistrationTestPage, measurementTable, renderTestPageDocument, type TestPageFieldAnchor } from '../testPage'

const AT = '2026-09-18T09:00:00.000Z'
const PAPER = { widthMm: 210, heightMm: 85 }

function template(): BankChequeTemplate {
  return createBankChequeTemplate({
    id: 'nbe-personal-en-2024',
    bankId: 'bank:nbe',
    bankName: 'National Bank of Egypt',
    name: 'NBE personal cheque',
    stockType: 'personal',
    paper: { ...PAPER, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
    fields: [
      { id: 'payee', key: 'payee', label: 'Pay to the order of', xMm: 12, yMm: 34, widthMm: 118, heightMm: 8 },
      { id: 'amount-numeric', key: 'amountNumeric', label: 'Amount', xMm: 150, yMm: 40, widthMm: 50, heightMm: 8, alignment: { horizontal: 'right', vertical: 'middle' }, source: 'amountDecimal' },
    ],
  })
}

const profile = createPrinterProfile(
  { id: 'hp', name: 'Office LaserJet', xOffsetMm: 1, yOffsetMm: 2, scale: { x: 1, y: 1 }, supportsCustomPageSize: true },
  AT
)

const calibration = createPrinterCalibration(
  {
    id: 'cal-1',
    printerProfileId: 'hp',
    templateId: 'nbe-personal-en-2024',
    templateVersion: 1,
    offsetXMm: 0.5,
    offsetYMm: -0.25,
    scaleX: 1,
    scaleY: 1,
    method: 'test-page',
    confidence: 'verified',
  },
  AT
)

const anchors = (t: BankChequeTemplate): TestPageFieldAnchor[] =>
  t.fields.map((field) => ({
    fieldId: field.id,
    label: field.label,
    xMm: field.xMm,
    yMm: field.yMm,
    widthMm: field.widthMm,
    heightMm: field.heightMm,
  }))

describe('the calibration test page', () => {
  it('draws rulers at a fixed millimetre step, with labels every 50mm', () => {
    const spec = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: AT })
    const xTicks = spec.marks.filter((mark) => mark.kind === 'ruler-tick' && mark.expectedYMm === 2)
    const yTicks = spec.marks.filter((mark) => mark.kind === 'ruler-tick' && mark.expectedXMm === 2)
    expect(xTicks.map((mark) => mark.expectedXMm)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210])
    expect(yTicks.length).toBe(9)
    const labels = spec.marks.filter((mark) => mark.kind === 'ruler-label')
    expect(labels.map((mark) => mark.label)).toEqual(['50mm', '100mm', '150mm', '200mm', '50mm'])
  })

  it('puts five registration marks on the sheet, including the centre', () => {
    const spec = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: AT })
    const marks = spec.marks.filter((mark) => mark.kind === 'registration')
    expect(marks).toHaveLength(5)
    expect(marks.map((mark) => mark.label)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(marks[4]?.expectedXMm).toBe(105)
    expect(marks[4]?.expectedYMm).toBe(42.5)
    expect(marks.every((mark) => mark.widthMm === 4 && mark.heightMm === 4)).toBe(true)
  })

  it('anchors a crosshair on every field centre, so a miss against the bank caption is measurable', () => {
    const t = template()
    const spec = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      fieldAnchors: anchors(t),
      measuredAt: AT,
    })
    const payee = spec.marks.find((mark) => mark.fieldId === 'payee')
    expect(payee?.kind).toBe('field-anchor')
    expect(payee?.expectedXMm).toBe(12 + 118 / 2)
    expect(payee?.expectedYMm).toBe(34 + 8 / 2)
    expect(payee?.label).toBe('Pay to the order of')
    // The mark box keeps the field's own extent, so the operator can see the width, not just the centre.
    expect(payee?.widthMm).toBe(118)
  })

  it('shifts the *placed* position by the current transform and leaves the expected target alone', () => {
    const t = template()
    const spec = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      fieldAnchors: anchors(t),
      transform: { profile, calibration },
      measuredAt: AT,
    })
    const payee = spec.marks.find((mark) => mark.fieldId === 'payee')!
    // Profile offset (1, 2) then calibration offset (0.5, -0.25): the printed mark lands 1.5mm right.
    expect(payee.placedXMm).toBe(roundMm(payee.expectedXMm + 1.5))
    expect(payee.placedYMm).toBe(roundMm(payee.expectedYMm + 1.75))
    expect(payee.expectedXMm).toBe(71)
    expect(spec.calibrated).toBe(true)
    expect(spec.instructions.join('\n')).toContain('current transform')
  })

  it('marks an uncalibrated page as uncalibrated instead of pretending the offsets are zero', () => {
    const spec = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      transform: { profile, calibration: null },
      measuredAt: AT,
    })
    expect(spec.calibrated).toBe(false)
    expect(spec.instructions.join('\n')).toContain('uncalibrated')
    const payee = spec.marks.find((mark) => mark.kind === 'registration')!
    // The nominal profile offsets are still applied, so the page measures the guess as it stands.
    expect(payee.placedXMm).toBe(payee.expectedXMm + 1)
  })

  it('shifts everything by the page margin, because the operator measures from the paper edge', () => {
    const noMargin = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: AT })
    const margined = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, marginMm: 5, measuredAt: AT })
    const first = noMargin.marks.find((mark) => mark.kind === 'registration')!
    const second = margined.marks.find((mark) => mark.kind === 'registration')!
    expect(second.expectedXMm).toBe(first.expectedXMm + 5)
    expect(second.expectedYMm).toBe(first.expectedYMm + 5)
  })

  it('tells the operator how to measure, including the two things that ruin a calibration', () => {
    const spec = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: AT })
    const text = spec.instructions.join('\n')
    expect(text).toContain('100%')
    expect(text).toContain('no driver scaling')
    expect(text).toContain('steel rule')
    expect(text).toContain('within 0.5 mm')
  })

  it('hashes the page so a calibration can be tied to the artefact it came from', () => {
    const a = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: AT })
    const b = buildRegistrationTestPage({ paper: PAPER, profileId: 'hp', templateId: 't', templateVersion: 1, measuredAt: '2030-01-01T00:00:00.000Z' })
    expect(a.hash.length).toBeGreaterThan(8)
    expect(a.hash).not.toBe(b.hash)
    expect(Object.isFrozen(a)).toBe(true)
    expect(a.id).toBe('testpage:hp:t:v1')
  })
})

describe('rendering the test page', () => {
  const spec = buildRegistrationTestPage({
    paper: PAPER,
    profileId: 'hp',
    templateId: 'nbe-personal-en-2024',
    templateVersion: 1,
    fieldAnchors: anchors(template()),
    measuredAt: AT,
  })
  const rendered = renderTestPageDocument(spec)

  it('is a standalone document sized to the physical stock', () => {
    expect(rendered.html).toContain('<!DOCTYPE html>')
    expect(rendered.html).toMatch(/@page\s*\{[^}]*size:\s*210mm 85mm/)
    expect(rendered.html).toMatch(/margin:\s*0/)
    expect(rendered.html).toContain('calibration-test-page')
  })

  it('places every mark in millimetres, never in pixels', () => {
    expect(rendered.markCount).toBe(spec.marks.length)
    expect(rendered.html).toMatch(/left:\s*\d+(\.\d+)?mm/)
    expect(rendered.html).not.toMatch(/width:\s*\d+px/)
    expect(rendered.html).not.toMatch(/font-size:\s*\d+px/)
    expect(rendered.bytes).toBe(new TextEncoder().encode(rendered.html).length)
  })

  it('escapes a label, because the field label is author data', () => {
    const risky = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: 't',
      templateVersion: 1,
      fieldAnchors: [{ fieldId: 'x', label: '<script>alert(1)</script>', xMm: 10, yMm: 10, widthMm: 20, heightMm: 8 }],
      measuredAt: AT,
    })
    const html = renderTestPageDocument(risky).html
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('carries no print trigger of its own — the transport decides when to print', () => {
    expect(rendered.html).not.toContain('window.print')
    expect(rendered.html).not.toContain('onload')
  })
})

describe('the measurement worksheet', () => {
  it('lists only the marks worth measuring, with empty cells for the ruler reading', () => {
    const spec = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      fieldAnchors: anchors(template()),
      measuredAt: AT,
    })
    const table = measurementTable(spec)
    expect(table.columns).toEqual(['mark', 'expected x mm', 'expected y mm', 'measured x mm', 'measured y mm'])
    expect(table.rows).toHaveLength(7)
    expect(table.rows.every((row) => row[3] === '' && row[4] === '')).toBe(true)
    expect(table.rows.map((row) => row[0])).toEqual([
      'registration-0',
      'registration-1',
      'registration-2',
      'registration-3',
      'registration-4',
      'anchor-payee',
      'anchor-amount-numeric',
    ])
    // Ruler ticks are deliberately absent: nobody measures a tick, they measure between them.
    expect(table.rows.some((row) => row[0]?.startsWith('tick'))).toBe(false)
  })
})

describe('the test page against the real layout', () => {
  it('aims a crosshair at the same millimetres the printer will ink', () => {
    const t = template()
    const layout = buildPrintLayout({
      template: t,
      data: createChequePrintData({
        chequeNumber: '1',
        date: '2026-09-18',
        payeeName: 'Crescent Trading',
        amountDecimal: '10.00',
        currency: 'EGP',
      }),
    })
    const spec = buildRegistrationTestPage({
      paper: PAPER,
      profileId: 'hp',
      templateId: t.id,
      templateVersion: t.version,
      fieldAnchors: anchors(t),
      measuredAt: AT,
    })
    const payeeRun = layout.runs.find((run) => run.fieldId === 'payee')!
    const anchor = spec.marks.find((mark) => mark.fieldId === 'payee')!
    expect(anchor.expectedXMm).toBeCloseTo(payeeRun.xMm + payeeRun.widthMm / 2, 3)
    expect(anchor.expectedYMm).toBeCloseTo(payeeRun.yMm + payeeRun.heightMm / 2, 3)
  })
})
