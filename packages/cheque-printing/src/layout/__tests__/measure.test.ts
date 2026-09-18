import { describe, expect, it } from 'vitest'
import { MM_PER_PT, roundMm } from '../../geometry/units'
import type { TemplateTypography } from '../../template/types'
import {
  MIN_FONT_SCALE,
  classifyFont,
  fitTextToWidth,
  lineHeightMm,
  measureTextMm,
  measureTextWidthPt,
} from '../measure'
import { stackLines, wrapText } from '../textWrap'

function typography(overrides: Partial<TemplateTypography> = {}): TemplateTypography {
  return {
    fontFamily: 'Times New Roman',
    fontSizePt: 10,
    fontWeight: 400,
    fontStyle: 'normal',
    lineHeight: 1.15,
    isMicr: false,
    direction: 'auto',
    ...overrides,
  }
}

describe('font classification', () => {
  it('maps the families real cheque templates use', () => {
    expect(classifyFont('Times New Roman')).toBe('serif')
    expect(classifyFont('Helvetica')).toBe('sans')
    expect(classifyFont('Arial Narrow')).toBe('sans')
    expect(classifyFont('Courier New')).toBe('monospace')
    expect(classifyFont('Traditional Arabic')).toBe('arabic')
    expect(classifyFont('Noto Naskh Arabic')).toBe('arabic')
    expect(classifyFont('MICR Encode')).toBe('monospace')
  })

  it('falls back to the wide assumption for an unknown family', () => {
    // An unknown family must not be *narrower* than reality, or the engine would declare a long
    // payee a fit and print it across the bank's rule.
    expect(classifyFont('Zoomies Display 3D')).toBe('sans')
  })

  it('prefers the Arabic class over the generic sans hint', () => {
    expect(classifyFont('Cairo Sans Arabic')).toBe('arabic')
  })
})

describe('deterministic text measurement', () => {
  it('is a pure function of its inputs', () => {
    const style = typography()
    expect(measureTextMm('Crescent Trading LLC', style)).toBe(measureTextMm('Crescent Trading LLC', style))
  })

  it('computes exactly what the documented model says', () => {
    // 10 characters of 'A' in a serif at 10pt: 10 × (10pt in mm) × 0.5 (serif) × 1.1 (cap letter).
    const expected = roundMm(10 * (10 * MM_PER_PT) * 0.5 * 1.1)
    expect(measureTextMm('AAAAAAAAAA', typography())).toBe(expected)
  })

  it('measures digits the way a tabular amount box needs', () => {
    const digits = measureTextMm('1234567890', typography())
    const expected = roundMm(10 * (10 * MM_PER_PT) * 0.5 * 0.56)
    expect(digits).toBe(expected)
  })

  it('grows monotonically with the text', () => {
    const short = measureTextMm('Acme', typography())
    const long = measureTextMm('Acme Industrial Holdings Limited', typography())
    expect(long).toBeGreaterThan(short)
  })

  it('distinguishes wide letters from narrow ones', () => {
    expect(measureTextMm('MMMM', typography())).toBeGreaterThan(measureTextMm('iiii', typography()))
  })

  it('widens for bold and italic, and adds tracking per gap', () => {
    const regular = measureTextMm('Payee Name', typography())
    expect(measureTextMm('Payee Name', typography({ fontWeight: 700 }))).toBeGreaterThan(regular)
    expect(measureTextMm('Payee Name', typography({ fontWeight: 600 }))).toBeGreaterThan(regular)
    expect(measureTextMm('Payee Name', typography({ fontStyle: 'italic' }))).toBeGreaterThan(regular)
    const tracked = measureTextMm('Payee Name', typography({ letterSpacingPt: 1 }))
    const gaps = [...'Payee Name'].length - 1
    expect(tracked).toBe(roundMm(regular + gaps * 1 * MM_PER_PT))
  })

  it('scales linearly with the font size', () => {
    expect(measureTextMm('Payee', typography({ fontSizePt: 20 }))).toBeCloseTo(
      measureTextMm('Payee', typography({ fontSizePt: 10 })) * 2,
      1
    )
  })

  it('returns zero for an empty string and a positive value for a space', () => {
    expect(measureTextMm('', typography())).toBe(0)
    expect(measureTextMm(' ', typography())).toBeGreaterThan(0)
  })

  it('converts to points for the document writer', () => {
    const mm = measureTextMm('1,500.00', typography())
    expect(measureTextWidthPt('1,500.00', typography())).toBe(roundMm(mm / MM_PER_PT))
  })

  it('reports a line height that honours the multiplier', () => {
    expect(lineHeightMm(typography())).toBe(roundMm(10 * 1.15 * MM_PER_PT))
    expect(lineHeightMm(typography({ lineHeight: undefined }))).toBe(roundMm(10 * 1.15 * MM_PER_PT))
    expect(lineHeightMm(typography({ lineHeight: 2 }))).toBe(roundMm(10 * 2 * MM_PER_PT))
  })
})

describe('shrink-to-fit', () => {
  it('leaves a fitting line at the authored size', () => {
    const style = typography()
    const fit = fitTextToWidth('Acme', style, 100)
    expect(fit.fits).toBe(true)
    expect(fit.fontSizePt).toBe(10)
    expect(fit.scale).toBe(1)
    expect(fit.availableWidthMm).toBe(100)
  })

  it('shrinks by the ratio the excess demands', () => {
    const style = typography()
    const text = 'Crescent Trading Holdings Limited'
    const required = measureTextMm(text, style)
    const available = roundMm(required * 0.8)
    const fit = fitTextToWidth(text, style, available)
    expect(fit.fits).toBe(true)
    expect(fit.scale).toBeCloseTo(0.8, 2)
    expect(fit.fontSizePt).toBeLessThan(10)
    expect(fit.requiredWidthMm).toBeLessThanOrEqual(available + 0.05)
  })

  it('refuses to shrink below the readability floor and says so', () => {
    const style = typography()
    const fit = fitTextToWidth('Crescent Trading Holdings Limited', style, 5)
    expect(fit.fits).toBe(false)
    expect(fit.scale).toBe(MIN_FONT_SCALE)
    expect(fit.fontSizePt).toBe(roundMm(10 * MIN_FONT_SCALE * 100) / 100)
    expect(fit.requiredWidthMm).toBeGreaterThan(5)
  })

  it('treats a zero-width box as unshrinkable rather than dividing by it', () => {
    const fit = fitTextToWidth('Payee', typography(), 0)
    expect(fit.fits).toBe(false)
    expect(fit.scale).toBe(1)
  })
})

describe('greedy wrapping', () => {
  const style = typography({ fontSizePt: 12 })

  it('wraps only where it must, and never past the width', () => {
    const text = 'Crescent Trading Holdings Limited Company'
    const width = measureTextMm('Crescent Trading', style)
    const wrapped = wrapText(text, style, width)
    expect(wrapped.lines.length).toBeGreaterThan(1)
    expect(wrapped.hardBroken).toBe(false)
    for (const line of wrapped.lines) {
      expect(measureTextMm(line, style)).toBeLessThanOrEqual(width + 0.01)
    }
    expect(wrapped.lines.join(' ')).toBe(text)
  })

  it('is deterministic', () => {
    const text = 'one two three four five six seven eight nine ten'
    const first = wrapText(text, style, 40).lines
    const second = wrapText(text, style, 40).lines
    expect(second).toEqual(first)
  })

  it('hard-breaks a word that is alone wider than the field', () => {
    const wrapped = wrapText('Supercalifragilistic', style, 8)
    expect(wrapped.hardBroken).toBe(true)
    expect(wrapped.lines.length).toBeGreaterThan(1)
  })

  it('leaves a short line alone', () => {
    expect(wrapText('Acme', style, 100)).toEqual({ lines: ['Acme'], hardBroken: false, widthExceeded: false })
  })

  it('keeps an empty value as one empty line, so the field still draws its box', () => {
    expect(wrapText('   ', style, 50).lines).toEqual([''])
  })
})

describe('line stacking inside the box', () => {
  const box = { boxTopMm: 10, boxHeightMm: 8, lineHeightMm: 5, lineCount: 1, vertical: 'top' as const }

  it('starts at the box top for a top-aligned block', () => {
    expect(stackLines(box)).toEqual({ firstLineTopMm: 10, overflowMm: 0 })
  })

  it('centres a block and reports the overflow when it does not fit', () => {
    const middle = stackLines({ ...box, lineCount: 1, vertical: 'middle' })
    expect(middle.firstLineTopMm).toBe(roundMm(10 + (8 - 5) / 2))
    const tall = stackLines({ ...box, lineCount: 3, vertical: 'middle' })
    expect(tall.overflowMm).toBe(roundMm(15 - 8))
  })

  it('grows upwards for bottom and baseline blocks, and reports the excess', () => {
    const bottom = stackLines({ ...box, lineCount: 2, vertical: 'bottom' })
    // Two 5mm lines in an 8mm box: the block starts 2mm above the box top and overflows by 2mm.
    expect(bottom.firstLineTopMm).toBe(roundMm(10 + 8 - 10))
    expect(bottom.overflowMm).toBe(roundMm(10 - 8))
    expect(stackLines({ ...box, lineCount: 2, vertical: 'baseline' }).firstLineTopMm).toBe(
      bottom.firstLineTopMm
    )
    const fits = stackLines({ ...box, boxHeightMm: 12, lineCount: 2, vertical: 'bottom' })
    expect(fits.overflowMm).toBe(0)
    expect(fits.firstLineTopMm).toBe(roundMm(10 + 12 - 10))
  })
})
