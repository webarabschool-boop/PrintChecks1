import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREVIEW_DPI,
  MM_PER_INCH,
  MM_PER_PT,
  PT_PER_MM,
  assertDpi,
  assertMm,
  formatMm,
  isPhysicalExtent,
  isValidMm,
  mmCss,
  mmToPx,
  mmToPt,
  pxToMm,
  ptCss,
  ptToMm,
  rectContains,
  rectIntersectionAreaMm2,
  rectsOverlap,
  roundMm,
  toTopLeftY,
  PhysicalUnitError,
} from '../units'

describe('physical units — millimetres are the source of truth', () => {
  it('uses the exact definitions of the inch and the point', () => {
    expect(MM_PER_INCH).toBe(25.4)
    expect(PT_PER_MM).toBeCloseTo(72 / 25.4, 12)
    expect(MM_PER_PT).toBeCloseTo(25.4 / 72, 12)
    // An inch is both 25.4mm and 72pt: the round trip must be the identity.
    expect(mmToPt(25.4)).toBe(72)
    expect(ptToMm(72)).toBe(25.4)
  })

  it('rounds to the canonical micron precision', () => {
    expect(roundMm(12.3456789)).toBe(12.346)
    expect(roundMm(-0.0004)).toBe(0) // -0 normalised, so a hash never sees "-0"
    expect(roundMm(0.0005)).toBe(0.001) // half-up at the last kept digit
    expect(roundMm(0.0001)).toBe(0) // below the engine's resolution
  })

  it('rejects non-finite and physically absurd lengths', () => {
    expect(isValidMm(Number.NaN)).toBe(false)
    expect(isValidMm(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidMm(6000)).toBe(false)
    expect(isValidMm(-5)).toBe(false)
    expect(isValidMm(-5, { allowNegative: true })).toBe(true)
    expect(isValidMm(0)).toBe(false)
    expect(isValidMm(0, { allowZero: true })).toBe(true)
    expect(isPhysicalExtent(210)).toBe(true)
    expect(isPhysicalExtent(0.2)).toBe(false)
    expect(() => assertMm(Number.NaN, 'field.xMm')).toThrow(/finite millimetre value/)
    expect(() => assertMm(6000, 'field.xMm')).toThrow(PhysicalUnitError)
    expect(assertMm(12.5, 'field.xMm')).toBe(12.5)
    expect(assertMm(-1.25, 'calibration.offsetXMm')).toBe(-1.25)
  })

  it('derives pixels only through an explicit DPI, and only for preview', () => {
    expect(mmToPx(25.4, DEFAULT_PREVIEW_DPI)).toBe(96)
    expect(mmToPx(100, 96)).toBe(377.953)
    expect(mmToPx(10, 300)).toBe(118.11)
    expect(pxToMm(96, 96)).toBe(25.4)
    expect(() => mmToPx(10, 0)).toThrow(PhysicalUnitError)
    expect(() => assertDpi(-72)).toThrow(/positive finite number/)
  })

  it('emits print-stable markup units', () => {
    expect(mmCss(42.5)).toBe('42.5mm')
    expect(mmCss(roundMm(1 / 3))).toBe('0.333mm')
    expect(ptCss(10.5)).toBe('10.5pt')
    expect(formatMm(0.0005)).toBe('0.001')
  })

  it('computes containment and overlap in millimetres', () => {
    const sheet = { xMm: 0, yMm: 0, widthMm: 210, heightMm: 85 }
    const inside = { xMm: 10, yMm: 10, widthMm: 20, heightMm: 5 }
    const hanging = { xMm: 200, yMm: 10, widthMm: 20, heightMm: 5 }
    expect(rectContains(sheet, inside)).toBe(true)
    expect(rectContains(sheet, hanging)).toBe(false)
    expect(rectsOverlap(inside, hanging)).toBe(false)
    expect(rectsOverlap({ ...inside, widthMm: 200 }, hanging)).toBe(true)
    expect(rectIntersectionAreaMm2(inside, { ...inside, xMm: 20 })).toBeCloseTo(10 * 5, 3)
    expect(rectIntersectionAreaMm2(inside, hanging)).toBe(0)
  })

  it('flips the y axis for a bottom-left measured template', () => {
    // A field 10mm from the bottom of an 85mm sheet, 8mm tall, starts 85 - (10 + 8) = 67 from the top.
    expect(toTopLeftY(10, 8, 85, 'bottom-left')).toBe(67)
    expect(toTopLeftY(10, 8, 85, 'top-left')).toBe(10)
  })
})
