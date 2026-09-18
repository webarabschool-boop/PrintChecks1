import { describe, expect, it } from 'vitest'
import {
  calibrationFingerprint,
  calibrationKey,
  createPrinterCalibration,
  deriveCalibration,
  validatePrinterCalibration,
  type MeasurementPoint,
} from '../calibration'
import { DEFAULT_CALIBRATION_LIMITS, type PrinterCalibration } from '../types'

const AT = '2026-09-18T09:00:00.000Z'

function cal(overrides: Partial<PrinterCalibration> = {}): PrinterCalibration {
  return createPrinterCalibration(
    {
      id: 'cal-1',
      printerProfileId: 'hp-laserjet-m402',
      templateId: 'nbe-personal-en-2024',
      templateVersion: 1,
      offsetXMm: 1.2,
      offsetYMm: -0.8,
      scaleX: 1.001,
      scaleY: 0.999,
      skewDeg: 0.1,
      method: 'test-page',
      confidence: 'verified',
      measuredAt: AT,
      ...overrides,
    },
    AT
  )
}

describe('calibration records', () => {
  it('is keyed by device and stock, never by device alone', () => {
    expect(calibrationKey('printer-a', 'template-x')).toBe('printer-a::template-x')
    expect(calibrationKey('printer-a', 'template-y')).not.toBe(calibrationKey('printer-a', 'template-x'))
  })

  it('normalises precision and freezes the record', () => {
    const created = createPrinterCalibration(
      {
        id: 'c',
        printerProfileId: 'p',
        templateId: 't',
        templateVersion: 1,
        offsetXMm: 0.123456789,
        offsetYMm: -0.0000001,
        method: 'manual-ruler',
      },
      AT
    )
    expect(created.offsetXMm).toBe(0.123)
    expect(created.offsetYMm).toBe(0) // negative zero never reaches JSON or a hash
    expect(created.scaleX).toBe(1)
    expect(created.scaleY).toBe(1)
    expect(created.confidence).toBe('draft')
    expect(created.skewDeg).toBeUndefined()
    expect(Object.isFrozen(created)).toBe(true)
  })

  it('is stored against the template version it was measured on', () => {
    expect(cal({ templateVersion: 3 }).templateVersion).toBe(3)
  })
})

describe('calibration limits — a big deviation is a fault, not a correction', () => {
  it('accepts a plausible measurement', () => {
    expect(validatePrinterCalibration(cal()).filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('refuses an offset beyond the limit, in either direction', () => {
    const tooFar = cal({ offsetXMm: DEFAULT_CALIBRATION_LIMITS.maxAllowedOffsetMm + 0.5, offsetYMm: 0 })
    const negative = cal({ offsetXMm: 0, offsetYMm: -(DEFAULT_CALIBRATION_LIMITS.maxAllowedOffsetMm + 0.5) })
    expect(validatePrinterCalibration(tooFar).map((issue) => issue.code)).toContain('CALIBRATION_OFFSET_EXCEEDS_LIMIT')
    expect(validatePrinterCalibration(negative).map((issue) => issue.code)).toContain('CALIBRATION_OFFSET_EXCEEDS_LIMIT')
  })

  it('lets a record raise its own limit, and respects it', () => {
    const loose = Object.freeze({ ...cal(), offsetXMm: 6, maxAllowedOffsetMm: 8 }) as PrinterCalibration
    expect(validatePrinterCalibration(loose).map((issue) => issue.code)).not.toContain('CALIBRATION_OFFSET_EXCEEDS_LIMIT')
  })

  it('refuses a scale that implies the driver resized the page', () => {
    const codes = validatePrinterCalibration(cal({ scaleX: 1.05 })).map((issue) => issue.code)
    expect(codes).toContain('CALIBRATION_SCALE_EXCEEDS_LIMIT')
    expect(validatePrinterCalibration(cal({ scaleY: 1.001 })).map((i) => i.code)).not.toContain('CALIBRATION_SCALE_EXCEEDS_LIMIT')
    expect(validatePrinterCalibration(cal({ scaleX: 4 })).map((i) => i.code)).toContain('CALIBRATION_SCALE_INVALID')
  })

  it('refuses a skew that is a paper-path problem', () => {
    expect(validatePrinterCalibration(cal({ skewDeg: 1.2 })).map((issue) => issue.code)).toContain('CALIBRATION_SKEW_EXCEEDS_LIMIT')
    expect(validatePrinterCalibration(cal({ skewDeg: -0.2 })).map((issue) => issue.code)).not.toContain('CALIBRATION_SKEW_EXCEEDS_LIMIT')
  })

  it('rejects a non-finite offset', () => {
    const broken = Object.freeze({ ...cal(), offsetXMm: Number.POSITIVE_INFINITY }) as PrinterCalibration
    expect(validatePrinterCalibration(broken).map((issue) => issue.code)).toContain('CALIBRATION_OFFSET_NOT_FINITE')
  })

  it('warns about a draft, and about a calibration claiming a MICR reader this phase does not have', () => {
    expect(validatePrinterCalibration(cal({ confidence: 'draft' })).map((issue) => issue.code)).toContain('CALIBRATION_DRAFT')
    expect(validatePrinterCalibration(cal({ method: 'micr-reader' })).map((issue) => issue.code)).toContain(
      'CALIBRATION_MICR_READER_UNAVAILABLE'
    )
  })
})

describe('deriving a calibration from measurements', () => {
  const points: readonly MeasurementPoint[] = [
    { id: 'R1', expectedXMm: 10, expectedYMm: 10, measuredXMm: 12.5, measuredYMm: 11.5 },
    { id: 'R2', expectedXMm: 110, expectedYMm: 10, measuredXMm: 112.5, measuredYMm: 11.5 },
    { id: 'R3', expectedXMm: 110, expectedYMm: 60, measuredXMm: 112.5, measuredYMm: 61.5 },
  ]

  it('takes the mean deviation as the offset and the span ratio as the scale', () => {
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points })
    expect(derived.calibration.offsetXMm).toBe(2.5)
    expect(derived.calibration.offsetYMm).toBe(1.5)
    expect(derived.calibration.scaleX).toBe(1)
    expect(derived.calibration.scaleY).toBe(1)
    expect(derived.rmsErrorMm).toBe(0)
    expect(derived.calibration.confidence).toBe('verified')
    expect(derived.calibration.method).toBe('test-page')
    expect(derived.calibration.id).toBe('cal_p::t')
  })

  it('is usable straight away: re-measuring the same sheet lands on the expected marks', () => {
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points })
    // Every point deviated by exactly the derived offset, so the residuals are all zero.
    for (const residual of derived.residualsMm) {
      expect(residual.dxMm).toBe(0)
      expect(residual.dyMm).toBe(0)
    }
  })

  it('reads a 1% horizontal stretch out of the span ratio', () => {
    const stretched: MeasurementPoint[] = [
      { id: 'R1', expectedXMm: 10, expectedYMm: 10, measuredXMm: 10.1, measuredYMm: 10 },
      { id: 'R2', expectedXMm: 110, expectedYMm: 10, measuredXMm: 111.1, measuredYMm: 10 },
      { id: 'R3', expectedXMm: 60, expectedYMm: 60, measuredXMm: 60.6, measuredYMm: 60 },
    ]
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: stretched })
    expect(derived.calibration.scaleX).toBeCloseTo(1.01, 5)
    expect(Math.abs(derived.calibration.scaleX - 1)).toBeLessThanOrEqual(DEFAULT_CALIBRATION_LIMITS.maxAllowedScaleError)
    expect(derived.calibration.scaleY).toBe(1)
  })

  it('reads skew from the y-deviation gradient, and only over a long enough span', () => {
    const tilted: MeasurementPoint[] = [
      { id: 'R1', expectedXMm: 10, expectedYMm: 20, measuredXMm: 10, measuredYMm: 20 },
      { id: 'R2', expectedXMm: 190, expectedYMm: 20, measuredXMm: 190, measuredYMm: 21 },
    ]
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: tilted })
    const expectedSkew = Math.round(((Math.atan2(1, 180) * 180) / Math.PI) * 1000) / 1000
    expect(derived.calibration.skewDeg).toBe(expectedSkew)
    expect(Math.abs(derived.calibration.skewDeg ?? 0)).toBeLessThanOrEqual(DEFAULT_CALIBRATION_LIMITS.maxAllowedSkewDeg)

    const shortSpan: MeasurementPoint[] = [
      { id: 'R1', expectedXMm: 10, expectedYMm: 20, measuredXMm: 10, measuredYMm: 20 },
      { id: 'R2', expectedXMm: 30, expectedYMm: 20, measuredXMm: 30, measuredYMm: 25 },
    ]
    expect(deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: shortSpan }).calibration.skewDeg).toBeUndefined()
  })

  it('calls two points a draft and three or more verified, because a residual needs a third', () => {
    const two: MeasurementPoint[] = [
      { id: 'R1', expectedXMm: 10, expectedYMm: 10, measuredXMm: 11, measuredYMm: 10 },
      { id: 'R2', expectedXMm: 110, expectedYMm: 60, measuredXMm: 111, measuredYMm: 60 },
    ]
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: two })
    expect(derived.calibration.confidence).toBe('draft')
    expect(derived.notes).toContain('2 measured point(s)')
  })

  it('reports an RMS that grows when the deviation is not a simple shift', () => {
    const messy: MeasurementPoint[] = [
      { id: 'R1', expectedXMm: 10, expectedYMm: 10, measuredXMm: 12, measuredYMm: 11 },
      { id: 'R2', expectedXMm: 110, expectedYMm: 10, measuredXMm: 111, measuredYMm: 11 },
      { id: 'R3', expectedXMm: 110, expectedYMm: 60, measuredXMm: 115, measuredYMm: 61 },
    ]
    const derived = deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: messy })
    expect(derived.rmsErrorMm).toBeGreaterThan(0.5)
    // The engine still refuses to hide a bad fit inside a bigger correction.
    expect(derived.notes).toContain('RMS residual')
  })

  it('refuses to invent a calibration out of nothing', () => {
    expect(() => deriveCalibration({ printerProfileId: 'p', templateId: 't', templateVersion: 1, points: [] })).toThrow(
      /at least one measured point/
    )
  })

  it('keeps a per-record limit through the factory', () => {
    const loose = createPrinterCalibration(
      {
        id: 'c',
        printerProfileId: 'p',
        templateId: 't',
        templateVersion: 1,
        offsetXMm: 6,
        offsetYMm: 0,
        method: 'test-page',
        maxAllowedOffsetMm: 8,
      },
      AT
    )
    expect(loose.maxAllowedOffsetMm).toBe(8)
    expect(validatePrinterCalibration(loose).map((issue) => issue.code)).not.toContain('CALIBRATION_OFFSET_EXCEEDS_LIMIT')
  })

  it('carries the test page it came from, so the correction can be re-measured on the same artefact', () => {
    const derived = deriveCalibration({
      printerProfileId: 'p',
      templateId: 't',
      templateVersion: 1,
      points,
      testPageHash: 'abc123',
      measuredBy: 'rana',
    })
    expect(derived.calibration.sourceTestPageHash).toBe('abc123')
    expect(derived.calibration.measuredBy).toBe('rana')
  })
})

describe('calibration fingerprint', () => {
  it('covers exactly the numbers that move the toner', () => {
    const a = cal()
    const b = cal({ notes: 'different note', measuredAt: '2020-01-01T00:00:00.000Z', confidence: 'draft' })
    expect(calibrationFingerprint(a)).toBe(calibrationFingerprint(b))
    expect(calibrationFingerprint(cal({ offsetXMm: 1.3 }))).not.toBe(calibrationFingerprint(a))
    expect(calibrationFingerprint(cal({ templateId: 'other' }))).not.toBe(calibrationFingerprint(a))
  })

  it('treats an absent skew as zero', () => {
    const withoutSkew = createPrinterCalibration(
      {
        id: 'c',
        printerProfileId: 'p',
        templateId: 't',
        templateVersion: 1,
        offsetXMm: 1.2,
        offsetYMm: -0.8,
        scaleX: 1.001,
        scaleY: 0.999,
        method: 'test-page',
        confidence: 'verified',
        measuredAt: AT,
      },
      AT
    )
    expect(calibrationFingerprint(withoutSkew)).toBe(calibrationFingerprint({ ...withoutSkew, skewDeg: 0 }))
  })
})
