import { describe, expect, it } from 'vitest'
import {
  analyseText,
  applyBidiIsolation,
  charClassOf,
  convertDigits,
  detectBaseDirection,
  hasBidiControls,
  isolateRun,
  resolveFieldDirection,
  stripBidiControls,
} from '../bidi'

describe('direction detection', () => {
  it('classifies the code points a cheque actually contains', () => {
    expect(charClassOf(0x0628)).toBe('strong-rtl') // ب
    expect(charClassOf(0x05d0)).toBe('strong-rtl') // א
    expect(charClassOf(0x41)).toBe('strong-ltr') // A
    expect(charClassOf(0x37)).toBe('digit') // 7
    expect(charClassOf(0x0665)).toBe('digit') // ٥ Arabic-Indic five
    expect(charClassOf(0x20)).toBe('neutral')
    expect(charClassOf(0x2d)).toBe('neutral') // hyphen
  })

  it('uses first-strong, with the template default as the fallback', () => {
    expect(detectBaseDirection('ادفعوا لأمر')).toBe('rtl')
    expect(detectBaseDirection('Crescent Trading LLC')).toBe('ltr')
    // Digits and punctuation are not strong: the stock's own direction decides.
    expect(detectBaseDirection('12345 ---', 'rtl')).toBe('rtl')
    expect(detectBaseDirection('', 'rtl')).toBe('rtl')
    expect(detectBaseDirection('', 'ltr')).toBe('ltr')
  })
})

describe('mixed-direction analysis', () => {
  it('splits an Arabic sentence containing a Latin name', () => {
    const analysis = analyseText('ادفعوا لأمر ABC Ltd')
    expect(analysis.baseDirection).toBe('rtl')
    expect(analysis.isMixed).toBe(true)
    expect(analysis.hasArabic).toBe(true)
    expect(analysis.hasLatinDigits).toBe(false)
    const directions = analysis.segments.map((segment) => segment.direction)
    expect(directions).toContain('rtl')
    expect(directions).toContain('ltr')
  })

  it('keeps digit runs isolated and tagged', () => {
    const analysis = analyseText('شيك 12345')
    const digits = analysis.segments.find((segment) => segment.isNumeric)
    expect(digits?.text).toBe('12345')
    expect(digits?.direction).toBe('ltr')
  })

  it('recognises Arabic-Indic digits', () => {
    const analysis = analyseText('المبلغ ١٢٣٤')
    expect(analysis.hasArabicIndicDigits).toBe(true)
    expect(analysis.hasLatinDigits).toBe(false)
  })

  it('does not call a single-direction line mixed', () => {
    expect(analyseText('مرحبا بالعالم').isMixed).toBe(false)
    expect(analyseText('Hello world').isMixed).toBe(false)
    expect(analyseText('').baseDirection).toBe('ltr')
  })
})

describe('bidi isolation on the printed text', () => {
  it('isolates only what needs isolating', () => {
    const isolated = applyBidiIsolation('شيك 12345', 'rtl')
    expect(isolated).toContain('\u2066')
    expect(isolated).toContain('\u2069')
    expect(stripBidiControls(isolated)).toBe('شيك 12345')
    // A pure RTL line is returned byte-for-byte unchanged: no control characters for nothing.
    expect(applyBidiIsolation('مرحبا بالعالم', 'rtl')).toBe('مرحبا بالعالم')
    expect(applyBidiIsolation('', 'rtl')).toBe('')
  })

  it('is idempotent', () => {
    const once = applyBidiIsolation('شيك 12345', 'rtl')
    expect(applyBidiIsolation(once, 'rtl')).toBe(once)
  })

  it('isolateRun is a no-op when the directions agree', () => {
    expect(isolateRun('12345', 'ltr', 'ltr')).toBe('12345')
    expect(hasBidiControls(isolateRun('12345', 'ltr', 'rtl'))).toBe(true)
  })
})

describe('digit conversion is opt-in', () => {
  it('converts both ways and never touches other characters', () => {
    expect(convertDigits('1,234.50', 'arabic-indic')).toBe('\u0661,\u0662\u0663\u0664.\u0665\u0660')
    expect(convertDigits(convertDigits('1234', 'arabic-indic'), 'latin')).toBe('1234')
    expect(convertDigits('١٢٣٤', 'latin')).toBe('1234')
    expect(convertDigits('۴۵', 'latin')).toBe('45') // extended Arabic-Indic
  })
})

describe('per-field direction resolution', () => {
  it('lets the template author override the content', () => {
    // An author who says "this field is LTR" gets LTR even for Arabic content — the account-number
    // box on some stocks is deliberately LTR while the sentence around it is RTL.
    expect(resolveFieldDirection('حساب 12345', 'ltr', 'rtl')).toBe('ltr')
    expect(resolveFieldDirection('حساب 12345', 'rtl', 'ltr')).toBe('rtl')
    expect(resolveFieldDirection('حساب 12345', 'auto', 'rtl')).toBe('rtl')
    expect(resolveFieldDirection('Crescent LLC', 'auto', 'rtl')).toBe('ltr')
  })

  it('lets the data override the template for one cheque', () => {
    expect(resolveFieldDirection('حساب', 'rtl', 'rtl', 'ltr')).toBe('ltr')
    expect(resolveFieldDirection('حساب', 'rtl', 'rtl', 'auto')).toBe('rtl')
    expect(resolveFieldDirection('12345', undefined, 'ltr')).toBe('ltr')
  })
})
