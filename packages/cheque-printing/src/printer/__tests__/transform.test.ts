import { describe, expect, it } from 'vitest'
import { roundMm } from '../../geometry/units'
import type { MmPoint, MmRect } from '../../geometry/units'
import { createBankChequeTemplate, type BankChequeTemplate } from '../../template'
import { validateTemplate } from '../../template'
import { bodyRectOnSheet, fieldRectOnSheet } from '../../template/geometry'
import {
  combinedScale,
  describeTransform,
  invertTransformedPoint,
  transformPoint,
  transformRect,
  type PrinterTransform,
} from '../transform'
import { createPrinterProfile, validatePrinterProfile } from '../profile'
import { DEFAULT_UNPRINTABLE_MARGIN_MM, type PrinterCalibration, type PrinterProfile } from '../types'

const AT = '2026-09-18T09:00:00.000Z'

function profile(overrides: Partial<Parameters<typeof createPrinterProfile>[0]> = {}): PrinterProfile {
  return createPrinterProfile(
    {
      id: 'hp-laserjet-m402',
      name: 'Office LaserJet',
      make: 'HP',
      model: 'LaserJet Pro M402dn',
      paperFeed: 'manual',
      nominalDpi: { x: 600, y: 600 },
      xOffsetMm: 1.5,
      yOffsetMm: -2,
      scale: { x: 1.01, y: 0.99 },
      supportsCustomPageSize: true,
      ...overrides,
    },
    AT
  )
}

function calibration(overrides: Partial<PrinterCalibration> = {}): PrinterCalibration {
  return Object.freeze({
    id: 'cal-1',
    printerProfileId: 'hp-laserjet-m402',
    templateId: 'fixture-cheque',
    templateVersion: 1,
    measuredAt: AT,
    offsetXMm: 0.4,
    offsetYMm: 0.2,
    scaleX: 1.002,
    scaleY: 0.998,
    method: 'test-page',
    confidence: 'verified',
    ...overrides,
  } as PrinterCalibration)
}

describe('printer profile', () => {
  it('fills in sane defaults and freezes the record', () => {
    const p = createPrinterProfile({ id: 'plain', name: 'Plain printer' }, AT)
    expect(p.paperFeed).toBe('manual')
    expect(p.nominalDpi).toEqual({ x: 600, y: 600 })
    expect(p.xOffsetMm).toBe(0)
    expect(p.scale).toEqual({ x: 1, y: 1 })
    expect(p.unprintableMarginMm).toEqual(DEFAULT_UNPRINTABLE_MARGIN_MM)
    expect(p.supportsCustomPageSize).toBe(false)
    expect(p.micrTonerCapable).toBe(false)
    expect(Object.isFrozen(p)).toBe(true)
    expect(p.createdAt).toBe(AT)
  })

  it('merges a partial margin instead of dropping the other three edges', () => {
    const p = createPrinterProfile({ id: 'x', name: 'n', unprintableMarginMm: { leftMm: 6.5 } }, AT)
    expect(p.unprintableMarginMm.leftMm).toBe(6.5)
    expect(p.unprintableMarginMm.rightMm).toBe(DEFAULT_UNPRINTABLE_MARGIN_MM.rightMm)
  })

  it('accepts a clean profile, including its nominal 1% offsets', () => {
    expect(validatePrinterProfile(profile())).toEqual([])
  })

  it('requires a name', () => {
    const issues = validatePrinterProfile(profile({ name: '  ' }))
    expect(issues.map((issue) => issue.code)).toContain('PROFILE_NAME_REQUIRED')
  })

  it('rejects an offset that is a paper-size mistake, not a device nudge', () => {
    const issues = validatePrinterProfile(profile({ xOffsetMm: 40 }))
    expect(issues.map((issue) => issue.code)).toContain('PROFILE_OFFSET_UNREALISTIC')
  })

  it('rejects a wild scale, and warns about a small one because it means the driver is resizing', () => {
    expect(validatePrinterProfile(profile({ scale: { x: 3, y: 1 } })).map((i) => i.code)).toContain('PROFILE_SCALE_UNREALISTIC')
    const biased = validatePrinterProfile(profile({ scale: { x: 1.05, y: 1 } }))
    expect(biased.map((issue) => issue.code)).toContain('PROFILE_SCALE_BIAS')
    expect(biased.every((issue) => issue.severity === 'warning')).toBe(true)
  })

  it('treats a nonsense DPI as a warning, because DPI never scales geometry', () => {
    const issues = validatePrinterProfile(profile({ nominalDpi: { x: 72, y: 600 } }))
    const dpi = issues.filter((issue) => issue.code === 'PROFILE_DPI_SUSPECT')
    expect(dpi).toHaveLength(1)
    expect(dpi[0]?.severity).toBe('warning')
  })

  it('warns about a tray on a manual-feed printer and about a driver without custom page sizes', () => {
    const issues = validatePrinterProfile(profile({ paperFeed: 'manual', trayId: 'Tray 2', supportsCustomPageSize: false }))
    const codes = issues.map((issue) => issue.code)
    expect(codes).toContain('PROFILE_TRAY_ON_MANUAL_FEED')
    expect(codes).toContain('PROFILE_NO_CUSTOM_PAGE_SIZE')
  })
})

describe('the printer transform', () => {
  const point: MmPoint = { xMm: 100, yMm: 50 }

  it('applies offset, then profile scale, then calibration, in that order', () => {
    const transform: PrinterTransform = { profile: profile(), calibration: calibration() }
    const expectedX = ((100 + 1.5) * 1.01 + 0.4) * 1.002
    const expectedY = ((50 - 2) * 0.99 + 0.2) * 0.998
    expect(transformPoint(point, transform)).toEqual({ xMm: roundMm(expectedX), yMm: roundMm(expectedY) })
  })

  it('is the nominal profile alone when nothing has been calibrated — and says so', () => {
    const transform: PrinterTransform = { profile: profile(), calibration: null }
    expect(transformPoint(point, transform)).toEqual({
      xMm: roundMm((100 + 1.5) * 1.01),
      yMm: roundMm((50 - 2) * 0.99),
    })
    const summary = describeTransform(transform, { widthMm: 210, heightMm: 85 })
    expect(summary.calibrated).toBe(false)
    expect(summary.label).toContain('uncalibrated')
    expect(combinedScale(transform)).toEqual({ x: 1.01, y: 0.99 })
  })

  it('never rescales by DPI: two profiles that differ only in nominal DPI print identically', () => {
    const at600 = { profile: profile({ nominalDpi: { x: 600, y: 600 } }), calibration: null }
    const at1200 = { profile: profile({ nominalDpi: { x: 1200, y: 1200 } }), calibration: null }
    expect(transformPoint(point, at1200)).toEqual(transformPoint(point, at600))
    expect(transformRect({ xMm: 10, yMm: 10, widthMm: 40, heightMm: 8 }, at1200)).toEqual(
      transformRect({ xMm: 10, yMm: 10, widthMm: 40, heightMm: 8 }, at600)
    )
  })

  it('transforms a rect by moving its origin and scaling its extent', () => {
    const transform: PrinterTransform = { profile: profile(), calibration: calibration() }
    const rect: MmRect = { xMm: 10, yMm: 20, widthMm: 100, heightMm: 8 }
    const moved = transformRect(rect, transform)
    const scale = combinedScale(transform)
    expect(moved.xMm).toBe(transformPoint({ xMm: 10, yMm: 20 }, transform).xMm)
    expect(moved.widthMm).toBe(roundMm(100 * scale.x))
    expect(moved.heightMm).toBe(roundMm(8 * scale.y))
  })

  it('counter-rotates skew about the pivot, leaving the pivot row alone', () => {
    const skewed = calibration({ skewDeg: 0.4, offsetXMm: 0, offsetYMm: 0, scaleX: 1, scaleY: 1 })
    const plain = calibration({ skewDeg: 0, offsetXMm: 0, offsetYMm: 0, scaleX: 1, scaleY: 1 })
    const flatProfile = profile({ xOffsetMm: 0, yOffsetMm: 0, scale: { x: 1, y: 1 } })
    const atPivot = transformPoint({ xMm: 0, yMm: 40 }, { profile: flatProfile, calibration: skewed })
    const unskewed = transformPoint({ xMm: 0, yMm: 40 }, { profile: flatProfile, calibration: plain })
    expect(atPivot).toEqual(unskewed)
    const farRight = transformPoint({ xMm: 200, yMm: 40 }, { profile: flatProfile, calibration: skewed })
    // The sheet came through tilted, so the right-hand end is lifted by tan(0.4°) × 200mm ≈ 1.4mm.
    expect(roundMm(unskewed.yMm - farRight.yMm)).toBe(roundMm(Math.tan((0.4 * Math.PI) / 180) * 200))
  })

  it('inverts to the millimetre it started from', () => {
    const transform: PrinterTransform = { profile: profile(), calibration: calibration() }
    const forward = transformPoint(point, transform)
    expect(invertTransformedPoint(forward, transform).xMm).toBeCloseTo(point.xMm, 2)
    expect(invertTransformedPoint(forward, transform).yMm).toBeCloseTo(point.yMm, 2)
  })

  it('inverts through a skew as well', () => {
    const flatProfile = profile({ xOffsetMm: 2, yOffsetMm: 1, scale: { x: 1, y: 1 } })
    const transform: PrinterTransform = {
      profile: flatProfile,
      calibration: calibration({ skewDeg: 0.3, offsetXMm: 1, offsetYMm: 0.5, scaleX: 1, scaleY: 1 }),
      skewPivotXMM: 105,
    }
    const round = invertTransformedPoint(transformPoint({ xMm: 180, yMm: 70 }, transform), transform)
    expect(round.xMm).toBeCloseTo(180, 1)
    expect(round.yMm).toBeCloseTo(70, 1)
  })

  it('reports the worst-case shift an operator should worry about', () => {
    const transform: PrinterTransform = { profile: profile(), calibration: calibration() }
    const paper = { widthMm: 210, heightMm: 85 }
    const summary = describeTransform(transform, paper)
    const corner = transformPoint({ xMm: 210, yMm: 85 }, transform)
    expect(summary.offsetXMm).toBe(roundMm(corner.xMm - 210))
    expect(summary.offsetYMm).toBe(roundMm(corner.yMm - 85))
    expect(summary.worstCaseShiftMm).toBe(roundMm(Math.hypot(corner.xMm - 210, corner.yMm - 85)))
    expect(summary.calibrated).toBe(true)
    expect(summary.label).toContain('calibration cal-1')
  })

  it('reads an uncalibrated template exactly as it was authored', () => {
    const template: BankChequeTemplate = createBankChequeTemplate({
      id: 'fixture-cheque',
      bankId: 'bank:fixture',
      bankName: 'Fixture Bank',
      name: 'Fixture',
      stockType: 'personal',
      paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
      fields: [{ id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 34, widthMm: 100, heightMm: 8 }],
    })
    const field = template.fields[0]!
    const authored = fieldRectOnSheet(template, field)
    expect(transformPoint(authored, { profile: profile({ xOffsetMm: 0, yOffsetMm: 0, scale: { x: 1, y: 1 } }), calibration: null })).toEqual({
      xMm: 12,
      yMm: 34,
    })
  })
})

describe('calibration independence (T7)', () => {
  function templateWithPayee(): BankChequeTemplate {
    return createBankChequeTemplate({
      id: 'fixture-cheque',
      bankId: 'bank:fixture',
      bankName: 'Fixture Bank',
      name: 'Fixture',
      stockType: 'personal',
      paper: { widthMm: 210, heightMm: 85, orientation: 'landscape', bodyOriginMm: { xMm: 0, yMm: 0 }, bodyWidthMm: 210, bodyHeightMm: 85 },
      fields: [{ id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 34, widthMm: 100, heightMm: 8 }],
    })
  }

  it('a print through the transform does not write back to the template', () => {
    const template = templateWithPayee()
    const before = JSON.stringify(template)
    const transform: PrinterTransform = { profile: profile(), calibration: calibration({ offsetXMm: 3, offsetYMm: -2.5 }) }
    const field = template.fields[0]!
    const moved = transformRect(fieldRectOnSheet(template, field), transform)
    expect(moved.xMm).not.toBe(field.xMm)
    expect(JSON.stringify(template)).toBe(before)
    expect(validateTemplate(template).ok).toBe(true)
    // And the template still carries no device geometry.
    expect(template.printerConfigHint).toBeUndefined()
  })

  it('two printers, one template: the layout is shared, the transforms are not', () => {
    const template = templateWithPayee()
    const rect = fieldRectOnSheet(template, template.fields[0]!)
    const office = { profile: profile(), calibration: null }
    const branch = {
      profile: createPrinterProfile({ id: 'brother', name: 'Branch Brother', xOffsetMm: -3, yOffsetMm: 1.2, scale: { x: 1, y: 1 } }, AT),
      calibration: calibration({ printerProfileId: 'brother', offsetXMm: 0.5, offsetYMm: 0, scaleX: 1, scaleY: 1 }),
    }
    const a = transformRect(rect, office)
    const b = transformRect(rect, branch)
    expect(a).not.toEqual(b)
    // Each device's own numbers, applied to the same authored millimetres.
    expect(a.xMm).toBe(roundMm((rect.xMm + 1.5) * 1.01))
    // The only difference between the two is the device numbers, never the template.
    expect(b.xMm).toBe(roundMm(((rect.xMm - 3) * 1 + 0.5) * 1))
    expect(bodyRectOnSheet(template).widthMm).toBe(210)
  })
})
