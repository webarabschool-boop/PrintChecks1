/**
 * Calibration records and the measurement loop.
 *
 * Precision printing is only credible if somebody measured something. The loop is: print the
 * registration test page on the real stock → measure where the marks actually landed → store the
 * deviation as a `PrinterCalibration` → the transform applies it to every subsequent print of that
 * (printer, stock) pair. If no measurement exists, the system says so out loud (rule: never silently
 * assume zero) rather than printing an uncalibrated cheque and letting the operator discover it.
 */

import { roundMm } from '../geometry/units'
import { hashCanonical } from '../canonical/hash'
import type { PrintingIssue } from '../errors'
import {
  DEFAULT_CALIBRATION_LIMITS,
  type CalibrationConfidence,
  type CalibrationLimits,
  type CalibrationMethod,
  type PrinterCalibration,
} from './types'

export interface CreateCalibrationInput {
  readonly id: string
  readonly printerProfileId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly offsetXMm: number
  readonly offsetYMm: number
  readonly scaleX?: number
  readonly scaleY?: number
  readonly skewDeg?: number
  readonly method: CalibrationMethod
  readonly confidence?: CalibrationConfidence
  readonly measuredBy?: string | null
  readonly sourceTestPageHash?: string | null
  readonly notes?: string | null
  /**
   * A device known to wander (an old feed assembly on its last legs) can carry a wider limit than
   * the default, so the record itself states what it tolerated when it was measured.
   */
  readonly maxAllowedOffsetMm?: number
  readonly maxAllowedScaleError?: number
  readonly measuredAt?: string
}

export function calibrationKey(printerProfileId: string, templateId: string): string {
  return `${printerProfileId}::${templateId}`
}

export function createPrinterCalibration(input: CreateCalibrationInput, measuredAt?: string): PrinterCalibration {
  const calibration: PrinterCalibration = {
    id: input.id,
    printerProfileId: input.printerProfileId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    // An explicit measurement time on the input wins: `measuredAt` here is the fallback the service
    // supplies when the caller has none, not an override of a record being re-read from storage.
    measuredAt: input.measuredAt ?? measuredAt ?? new Date().toISOString(),
    ...(input.measuredBy === undefined ? {} : { measuredBy: input.measuredBy }),
    offsetXMm: roundMm(input.offsetXMm),
    offsetYMm: roundMm(input.offsetYMm),
    scaleX: round(scaleXOr(input.scaleX), 5),
    scaleY: round(scaleXOr(input.scaleY), 5),
    ...(input.skewDeg === undefined ? {} : { skewDeg: roundMm(input.skewDeg) }),
    method: input.method,
    confidence: input.confidence ?? 'draft',
    ...(input.maxAllowedOffsetMm === undefined ? {} : { maxAllowedOffsetMm: roundMm(input.maxAllowedOffsetMm) }),
    ...(input.maxAllowedScaleError === undefined ? {} : { maxAllowedScaleError: round(input.maxAllowedScaleError, 6) }),
    ...(input.sourceTestPageHash === undefined ? {} : { sourceTestPageHash: input.sourceTestPageHash }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  }
  return Object.freeze(calibration)
}

function scaleXOr(value: number | undefined): number {
  return value === undefined ? 1 : value
}

/**
 * Scale and skew are kept to 6 decimals (a scale of 1.000001 = 1 µm per metre). Millimetre
 * positions go through `roundMm`, which is the engine's canonical 1-micron precision.
 */
function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

export function validatePrinterCalibration(
  calibration: PrinterCalibration,
  limits: CalibrationLimits = DEFAULT_CALIBRATION_LIMITS
): PrintingIssue[] {
  const issues: PrintingIssue[] = []
  const maxOffset = calibration.maxAllowedOffsetMm ?? limits.maxAllowedOffsetMm

  for (const [label, value] of [
    ['offsetXMm', calibration.offsetXMm],
    ['offsetYMm', calibration.offsetYMm],
  ] as const) {
    if (!Number.isFinite(value)) {
      issues.push({
        code: 'CALIBRATION_OFFSET_NOT_FINITE',
        severity: 'error',
        message: `${label} must be a finite millimetre number`,
        remediation: 're-measure from the test page',
      })
    } else if (Math.abs(value) > maxOffset) {
      issues.push({
        code: 'CALIBRATION_OFFSET_EXCEEDS_LIMIT',
        severity: 'error',
        message: `${label} = ${String(value)}mm exceeds the ${String(maxOffset)}mm limit. A deviation that large is not a calibration — it is a wrong paper size, a driver "fit to page" setting, or the wrong stock in the feeder`,
        remediation: 'check the driver page setup and the physical stock, then re-measure',
      })
    }
  }

  for (const [label, value] of [
    ['scaleX', calibration.scaleX],
    ['scaleY', calibration.scaleY],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0.5 || value >= 2) {
      issues.push({
        code: 'CALIBRATION_SCALE_INVALID',
        severity: 'error',
        message: `${label} = ${String(value)} is not a plausible measured scale (must be within 0.5–2.0)`,
        remediation: 're-measure the ruler spans on the test page',
      })
      continue
    }
    if (Math.abs(value - 1) > limits.maxAllowedScaleError) {
      issues.push({
        code: 'CALIBRATION_SCALE_EXCEEDS_LIMIT',
        severity: 'error',
        message: `${label} differs from 1.0 by more than ${String(limits.maxAllowedScaleError * 100)}% — a laser printer does not scale 2% silently`,
        remediation: 'disable driver scaling and re-measure; keep the record only if the residual is small',
      })
    }
  }

  if (calibration.skewDeg !== undefined && Math.abs(calibration.skewDeg) > limits.maxAllowedSkewDeg) {
    issues.push({
      code: 'CALIBRATION_SKEW_EXCEEDS_LIMIT',
      severity: 'error',
      message: `skew of ${String(calibration.skewDeg)}° exceeds ${String(limits.maxAllowedSkewDeg)}° — that is a paper path problem, not something to compensate`,
      remediation: 'clean the rollers / use fresh stock, then re-measure',
    })
  }

  if (calibration.method === 'micr-reader') {
    issues.push({
      code: 'CALIBRATION_MICR_READER_UNAVAILABLE',
      severity: 'warning',
      message: 'this calibration claims a MICR-reader measurement, but this phase prints no MICR band to measure',
      remediation: 're-record it as "test-page" or "manual-ruler"',
    })
  }

  if (calibration.confidence === 'draft') {
    issues.push({
      code: 'CALIBRATION_DRAFT',
      severity: 'warning',
      message: 'this calibration is a draft: it has not been verified against a second test page',
      remediation: 'print a test page after the first real cheque and mark it verified',
    })
  }

  return issues
}

export interface MeasurementPoint {
  readonly id: string
  readonly expectedXMm: number
  readonly expectedYMm: number
  readonly measuredXMm: number
  readonly measuredYMm: number
}

export interface DeriveCalibrationInput {
  readonly printerProfileId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly points: readonly MeasurementPoint[]
  readonly method?: CalibrationMethod
  readonly measuredBy?: string | null
  readonly id?: string
  readonly testPageHash?: string
}

export interface DerivedCalibration {
  readonly calibration: PrinterCalibration
  readonly residualsMm: readonly { readonly id: string; readonly dxMm: number; readonly dyMm: number }[]
  readonly rmsErrorMm: number
  readonly notes: string
}

/**
 * Least-squares-free by design: the offset is the mean deviation, the scale is the ratio of
 * measured span to expected span across the widest pair of points. Two points are enough to correct
 * position and scale; a third is what makes the residual meaningful, so the report states the RMS
 * of all residuals rather than pretending a 2-point fit is a calibration curve.
 */
export function deriveCalibration(input: DeriveCalibrationInput): DerivedCalibration {
  if (input.points.length === 0) {
    throw new Error('deriveCalibration needs at least one measured point')
  }
  const dxSum = input.points.reduce((sum, point) => sum + (point.measuredXMm - point.expectedXMm), 0)
  const dySum = input.points.reduce((sum, point) => sum + (point.measuredYMm - point.expectedYMm), 0)
  const offsetXMm = dxSum / input.points.length
  const offsetYMm = dySum / input.points.length

  const sortedByX = [...input.points].sort((a, b) => a.expectedXMm - b.expectedXMm)
  const first = sortedByX[0]
  const last = sortedByX[sortedByX.length - 1]
  let scaleX = 1
  let scaleY = 1
  if (first !== undefined && last !== undefined && last.expectedXMm - first.expectedXMm > 20) {
    const expectedSpan = last.expectedXMm - first.expectedXMm
    const measuredSpan = last.measuredXMm - first.measuredXMm
    if (measuredSpan > 0 && expectedSpan > 0) scaleX = measuredSpan / expectedSpan

    const sortedByY = [...input.points].sort((a, b) => a.expectedYMm - b.expectedYMm)
    const firstY = sortedByY[0]
    const lastY = sortedByY[sortedByY.length - 1]
    if (firstY !== undefined && lastY !== undefined) {
      const expectedYSpan = lastY.expectedYMm - firstY.expectedYMm
      const measuredYSpan = lastY.measuredYMm - firstY.measuredYMm
      if (expectedYSpan > 20 && measuredYSpan > 0) scaleY = measuredYSpan / expectedYSpan
    }
  }

  const skewDeg = estimateSkewDeg(input.points)

  const residuals = input.points.map((point) => ({
    id: point.id,
    dxMm: roundMm(point.measuredXMm - (point.expectedXMm + offsetXMm)),
    dyMm: roundMm(point.measuredYMm - (point.expectedYMm + offsetYMm)),
  }))
  const squares = residuals.reduce(
    (sum, residual) => sum + residual.dxMm * residual.dxMm + residual.dyMm * residual.dyMm,
    0
  )
  const rmsErrorMm = round(Math.sqrt(squares / (residuals.length * 2)), 3)

  const calibration = createPrinterCalibration(
    {
      id: input.id ?? `cal_${calibrationKey(input.printerProfileId, input.templateId)}`,
      printerProfileId: input.printerProfileId,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      offsetXMm,
      offsetYMm,
      scaleX,
      scaleY,
      skewDeg,
      method: input.method ?? 'test-page',
      confidence: input.points.length >= 3 ? 'verified' : 'draft',
      ...(input.measuredBy === undefined ? {} : { measuredBy: input.measuredBy }),
      ...(input.testPageHash === undefined ? {} : { sourceTestPageHash: input.testPageHash }),
    },
    new Date().toISOString()
  )

  return {
    calibration,
    residualsMm: residuals,
    rmsErrorMm,
    notes:
      `derived from ${String(input.points.length)} measured point(s); ` +
      `RMS residual ${String(rmsErrorMm)}mm after offset only ` +
      `(scale ${calibration.scaleX}/${calibration.scaleY}, skew ${String(calibration.skewDeg ?? 0)}°)`,
  }
}

/** Skew from the y-residual gradient across x: how much the sheet rotated on the way through. */
function estimateSkewDeg(points: readonly MeasurementPoint[]): number | undefined {
  if (points.length < 2) return undefined
  const sorted = [...points].sort((a, b) => a.expectedXMm - b.expectedXMm)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (first === undefined || last === undefined) return undefined
  const span = last.expectedXMm - first.expectedXMm
  if (span < 50) return undefined
  const dy = last.measuredYMm - last.expectedYMm - (first.measuredYMm - first.expectedYMm)
  return round((Math.atan2(dy, span) * 180) / Math.PI, 3)
}

export function calibrationFingerprint(calibration: PrinterCalibration): string {
  return hashCanonical({
    printerProfileId: calibration.printerProfileId,
    templateId: calibration.templateId,
    templateVersion: calibration.templateVersion,
    offsetXMm: calibration.offsetXMm,
    offsetYMm: calibration.offsetYMm,
    scaleX: calibration.scaleX,
    scaleY: calibration.scaleY,
    skewDeg: calibration.skewDeg ?? 0,
  })
}
