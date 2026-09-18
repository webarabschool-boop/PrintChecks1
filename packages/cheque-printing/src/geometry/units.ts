/**
 * Physical units — the geometry foundation of the printing engine.
 *
 * **Millimetres are the source of truth** (docs/ARCHITECTURE.md §7, rule T1). Every
 * coordinate in a template, in a layout run and in a calibration record is a millimetre
 * value; typography uses typographic points, which are themselves an absolute physical
 * unit (1pt = 1/72 inch) and therefore print-stable. Pixels appear in exactly one place:
 * the on-screen preview, where they are *derived* from millimetres at a declared DPI and
 * never fed back (rule T5, principle P5).
 *
 * This module is deliberately free of DOM, `Intl` and device access: it runs identically in
 * Node, in a browser and inside a print worker, which is what makes the layout engine
 * deterministically testable (testing rule TT2).
 */

/** Exact — the inch is defined as 25.4 mm. */
export const MM_PER_INCH = 25.4

/** Exact — the pica point is defined as 1/72 inch. */
export const PT_PER_INCH = 72

/** 0.0352777... mm per point — derived from the exact definitions above, never hand-rounded. */
export const MM_PER_PT = MM_PER_INCH / PT_PER_INCH

export const PT_PER_MM = PT_PER_INCH / MM_PER_INCH

/**
 * Default preview DPI. 96 CSS px per inch is what a browser means by "100% zoom" — it is a
 * *screen* convention, not a print resolution, which is why it only ever shows up in the
 * preview path and never in print geometry.
 */
export const DEFAULT_PREVIEW_DPI = 96

/**
 * Millimetre precision kept in the output. 3 decimals = 1 µm, far finer than any laser
 * printer's mechanical accuracy (~0.25 mm), and enough that a rounding step can never shift
 * a glyph by a perceptible amount while still keeping `layoutHash` stable.
 */
export const MM_DECIMALS = 3

export interface MmPoint {
  readonly xMm: number
  readonly yMm: number
}

export interface MmRect {
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number
}

export interface MmExtent {
  readonly widthMm: number
  readonly heightMm: number
}

/** Round to the canonical millimetre precision. Deterministic for negative values too. */
export function roundMm(value: number): number {
  const factor = 10 ** MM_DECIMALS
  const scaled = value * factor
  // Math.round(-0.5) === -0 in JS; normalise so that -0 never reaches JSON or a hash.
  const rounded = Math.round(scaled)
  const result = rounded / factor
  return Object.is(result, -0) ? 0 : result
}

export interface MmValidityOptions {
  /** Zero is meaningful for an offset (no correction), never for an extent. */
  readonly allowZero?: boolean
  /** Offsets and calibration corrections are signed; sizes and positions are not. */
  readonly allowNegative?: boolean
}

/** A usable millimetre value: finite, signed as allowed, within a sane physical range. */
export function isValidMm(value: number, options: MmValidityOptions = {}): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (value === 0) return options.allowZero === true
  if (value < 0) return options.allowNegative === true
  return value <= MAX_PHYSICAL_MM
}

/** A printable extent: at least half a millimetre, at most five metres of paper. */
export function isPhysicalExtent(value: number): boolean {
  return Number.isFinite(value) && value >= 0.5 && value <= MAX_PHYSICAL_MM
}

const MAX_PHYSICAL_MM = 5000

export class PhysicalUnitError extends Error {
  readonly code = 'PHYSICAL_UNIT_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'PhysicalUnitError'
  }
}

export function assertMm(value: number, label: string): number {
  if (!isValidMm(value, { allowZero: true, allowNegative: true })) {
    throw new PhysicalUnitError(
      `${label} must be a finite millimetre value within +/-${String(MAX_PHYSICAL_MM)}mm, got ${String(value)}`
    )
  }
  return roundMm(value)
}

export function mmToPt(mm: number): number {
  return roundMm(mm * PT_PER_MM)
}

export function ptToMm(pt: number): number {
  return roundMm(pt * MM_PER_PT)
}

/** Preview-only conversion (T5). `dpi` must be explicit at the call site. */
export function mmToPx(mm: number, dpi: number): number {
  assertDpi(dpi)
  return roundMm((mm / MM_PER_INCH) * dpi)
}

export function pxToMm(px: number, dpi: number): number {
  assertDpi(dpi)
  return roundMm((px / dpi) * MM_PER_INCH)
}

export function assertDpi(dpi: number): void {
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > 4000) {
    throw new PhysicalUnitError(`DPI must be a positive finite number, got ${String(dpi)}`)
  }
}

/** Print markup helpers — the browser only ever has to multiply these by 1. */
export function mmCss(mm: number): string {
  return `${formatMm(mm)}mm`
}

export function ptCss(pt: number): string {
  return `${formatPt(pt)}pt`
}

export function formatMm(mm: number): string {
  return String(roundMm(mm))
}

export function formatPt(pt: number): string {
  return String(Math.round(pt * 100) / 100)
}

export function rectContains(outer: MmRect, inner: MmRect, toleranceMm = 0): boolean {
  return (
    inner.xMm >= outer.xMm - toleranceMm &&
    inner.yMm >= outer.yMm - toleranceMm &&
    inner.xMm + inner.widthMm <= outer.xMm + outer.widthMm + toleranceMm &&
    inner.yMm + inner.heightMm <= outer.yMm + outer.heightMm + toleranceMm
  )
}

export function rectIntersectionAreaMm2(a: MmRect, b: MmRect): number {
  const x = Math.max(a.xMm, b.xMm)
  const y = Math.max(a.yMm, b.yMm)
  const right = Math.min(a.xMm + a.widthMm, b.xMm + b.widthMm)
  const bottom = Math.min(a.yMm + a.heightMm, b.yMm + b.heightMm)
  if (right <= x || bottom <= y) return 0
  return roundMm((right - x) * (bottom - y))
}

export function rectsOverlap(a: MmRect, b: MmRect, toleranceMm = 0): boolean {
  return (
    a.xMm + a.widthMm - toleranceMm > b.xMm &&
    b.xMm + b.widthMm - toleranceMm > a.xMm &&
    a.yMm + a.heightMm - toleranceMm > b.yMm &&
    b.yMm + b.heightMm - toleranceMm > a.yMm
  )
}

/**
 * Templates may anchor from the bottom-left (the convention on some voucher stocks). The
 * engine normalises everything to a top-left sheet coordinate system, which is what CSS
 * absolute positioning and `@page` both use.
 */
export function toTopLeftY(
  yMm: number,
  heightMm: number,
  paperHeightMm: number,
  origin: 'top-left' | 'bottom-left'
): number {
  if (origin === 'top-left') return roundMm(yMm)
  return roundMm(paperHeightMm - (yMm + heightMm))
}

/** Human-readable physical summary, used in the designer UI and in audit records. */
export function describeExtent(extent: MmExtent): string {
  return `${formatMm(extent.widthMm)} x ${formatMm(extent.heightMm)} mm`
}
