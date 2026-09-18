/**
 * The printer transform — the ONLY place a device's behaviour touches geometry, and it never
 * writes back.
 *
 *     final = (templateMm + profileOffset) * profileScale + calibrationOffset, all * calibrationScale
 *
 * Profile offsets are a guess made once when the device is registered; calibration values are
 * measured on the real stock with a ruler. Keeping them separate and additive means a new printer
 * costs a measurement, not a template edit — and it is what makes the promise "calibration never
 * mutates the template" testable: these functions take a template rectangle in and return a
 * different number, with the input untouched (a frozen object, enforced at construction).
 *
 * Note what is NOT here: any rescaling by DPI. A page declared as `size: 210mm 85mm` is already
 * physical; a driver that renders 600 dpi and one that renders 1200 dpi must both put the toner in
 * the same millimetre. Multiplying by a nominal DPI is how a print job ends up 15% off.
 */

import { roundMm, type MmPoint, type MmRect } from '../geometry/units'
import type { PrinterCalibration, PrinterProfile } from './types'

export interface PrinterTransform {
  readonly profile: PrinterProfile
  /** `null` means uncalibrated: the profile's nominal offsets only, and the caller must say so. */
  readonly calibration: PrinterCalibration | null
  /** Sheet point the skew is measured around. Defaults to the sheet's left edge (x = 0). */
  readonly skewPivotXMM?: number
}

export interface ScaleFactors {
  readonly x: number
  readonly y: number
}

export function combinedScale(transform: PrinterTransform): ScaleFactors {
  const calibration = transform.calibration
  return {
    x: transform.profile.scale.x * (calibration === null ? 1 : calibration.scaleX),
    y: transform.profile.scale.y * (calibration === null ? 1 : calibration.scaleY),
  }
}

export function transformPoint(point: MmPoint, transform: PrinterTransform): MmPoint {
  const { profile, calibration } = transform
  let xMm = (point.xMm + profile.xOffsetMm) * profile.scale.x
  let yMm = (point.yMm + profile.yOffsetMm) * profile.scale.y

  if (calibration !== null) {
    xMm = (xMm + calibration.offsetXMm) * calibration.scaleX
    yMm = (yMm + calibration.offsetYMm) * calibration.scaleY
    if (calibration.skewDeg !== undefined && calibration.skewDeg !== 0) {
      const pivot = transform.skewPivotXMM ?? 0
      // The sheet rotated by skewDeg on the way through; counter-rotate the content about the
      // pivot. Small-angle tangent form — at 0.5° the difference from a full rotation matrix is
      // far below a micron on a cheque-sized page.
      yMm = yMm - Math.tan((calibration.skewDeg * Math.PI) / 180) * (xMm - pivot)
    }
  }

  return { xMm: roundMm(xMm), yMm: roundMm(yMm) }
}

export function transformRect(rect: MmRect, transform: PrinterTransform): MmRect {
  const scale = combinedScale(transform)
  const origin = transformPoint({ xMm: rect.xMm, yMm: rect.yMm }, transform)
  return {
    xMm: origin.xMm,
    yMm: origin.yMm,
    widthMm: roundMm(rect.widthMm * scale.x),
    heightMm: roundMm(rect.heightMm * scale.y),
  }
}

/** The inverse, used by the calibration round-trip test and by "what did the printer really do". */
export function invertTransformedPoint(point: MmPoint, transform: PrinterTransform): MmPoint {
  const { profile, calibration } = transform
  let xMm = point.xMm
  let yMm = point.yMm
  if (calibration !== null) {
    if (calibration.skewDeg !== undefined && calibration.skewDeg !== 0) {
      const pivot = transform.skewPivotXMM ?? 0
      yMm = yMm + Math.tan((calibration.skewDeg * Math.PI) / 180) * (xMm - pivot)
    }
    if (calibration.scaleX !== 0) xMm = xMm / calibration.scaleX - calibration.offsetXMm
    if (calibration.scaleY !== 0) yMm = yMm / calibration.scaleY - calibration.offsetYMm
  }
  if (profile.scale.x !== 0) xMm = xMm / profile.scale.x - profile.xOffsetMm
  if (profile.scale.y !== 0) yMm = yMm / profile.scale.y - profile.yOffsetMm
  return { xMm: roundMm(xMm), yMm: roundMm(yMm) }
}

export interface TransformSummary {
  readonly label: string
  readonly calibrated: boolean
  readonly offsetXMm: number
  readonly offsetYMm: number
  readonly scale: ScaleFactors
  readonly skewDeg: number
  /** Total displacement at the sheet's far corner — the number an operator should be alarmed by. */
  readonly worstCaseShiftMm: number
}

export function describeTransform(
  transform: PrinterTransform,
  paper: { readonly widthMm: number; readonly heightMm: number }
): TransformSummary {
  const shifted = transformPoint({ xMm: paper.widthMm, yMm: paper.heightMm }, transform)
  const dx = shifted.xMm - paper.widthMm
  const dy = shifted.yMm - paper.heightMm
  const calibration = transform.calibration
  return {
    label:
      calibration === null
        ? `${transform.profile.name} (uncalibrated — nominal profile offsets only)`
        : `${transform.profile.name} + calibration ${calibration.id} (${calibration.confidence})`,
    calibrated: calibration !== null,
    offsetXMm: roundMm(dx),
    offsetYMm: roundMm(dy),
    scale: combinedScale(transform),
    skewDeg: calibration?.skewDeg ?? 0,
    worstCaseShiftMm: roundMm(Math.sqrt(dx * dx + dy * dy)),
  }
}
