/**
 * Deterministic text metrics — an estimator, not a font engine.
 *
 * The engine has to decide *before printing* whether a 55-character payee fits the 118 mm rule on
 * the stock, and it cannot measure text in a browser and then feed the answer back into print
 * geometry (T5 forbids preview-influences-print, and it would make a print record non-reproducible
 * across machines). So the layout engine uses a documented advance-width model: enough to make the
 * overflow decision identically everywhere, and deliberately conservative — it over-estimates, so a
 * line the engine says fits really does fit.
 *
 * If you came here looking for exact glyph metrics: that is a font-metrics dependency (opentype.js
 * or an equivalent) and it is intentionally NOT a Phase 2 dependency. The calibration test page is
 * what closes the gap between this estimate and the physical sheet.
 */

import { MM_PER_PT, roundMm } from '../geometry/units'
import type { TemplateTypography } from '../template/types'

/** Nominal average advance width as a fraction of the font size, per family class. */
const WIDTH_FACTORS = {
  serif: 0.5,
  sans: 0.52,
  monospace: 0.6,
  arabic: 0.44,
  cjk: 1.0,
} as const

export type FontClass = keyof typeof WIDTH_FACTORS

const MONOSPACE_HINTS = ['courier', 'mono', 'micr', 'consolas', 'dejavu sans mono']
const SANS_HINTS = ['helvetica', 'arial', 'roboto', 'inter', 'segoe', 'verdana', 'sans']
const ARABIC_HINTS = ['arabic', 'amiri', 'scheherazade', 'naskh', 'kufi', 'cairo', 'tajawal']
const SERIF_HINTS = ['times', 'georgia', 'garamond', 'serif', 'palatino']

export function classifyFont(fontFamily: string): FontClass {
  const family = fontFamily.toLowerCase()
  if (ARABIC_HINTS.some((hint) => family.includes(hint))) return 'arabic'
  if (MONOSPACE_HINTS.some((hint) => family.includes(hint))) return 'monospace'
  if (SANS_HINTS.some((hint) => family.includes(hint))) return 'sans'
  if (SERIF_HINTS.some((hint) => family.includes(hint))) return 'serif'
  // Unknown families are treated as the widest common case so the fit decision errs safe.
  return 'sans'
}

/** Per-character advance multiplier — wide scripts and digits are not the same width as 'i'. */
function charFactor(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x20) return 0.3
  if (code >= 0x30 && code <= 0x39) return 0.56 // digits: tabular-ish on most stocks
  if (code >= 0x0600 && code <= 0x06ff) return 0.62 // Arabic joining already narrows the run
  if (code >= 0x4e00 && code <= 0x9fff) return 1.9
  if (char === 'i' || char === 'l' || char === '.' || char === ',' || char === "'" || char === '!') return 0.3
  if (char === 'm' || char === 'M' || char === 'W' || char === 'w') return 1.35
  if (char === 'j' || char === 't' || char === 'f' || char === 'r' || char === '-' || char === ' ') return 0.35
  if (/[A-Z]/.test(char)) return 1.1
  return 0.55
}

/**
 * Advance width of `text` in millimetres for one typographic run.
 * Bold is +4%, italic +1% (slant does not widen much on a cheque face), and letter-spacing is
 * added per gap — the three knobs real cheque templates actually use.
 */
export function measureTextMm(text: string, typography: TemplateTypography): number {
  if (text.length === 0) return 0
  const base = typography.fontSizePt * MM_PER_PT
  const classFactor = WIDTH_FACTORS[classifyFont(typography.fontFamily)]
  const weightFactor = typography.fontWeight >= 700 ? 1.04 : typography.fontWeight >= 600 ? 1.02 : 1
  const styleFactor = typography.fontStyle === 'italic' ? 1.01 : 1
  const letterSpacingMm = (typography.letterSpacingPt ?? 0) * MM_PER_PT

  let advance = 0
  for (const char of text) {
    advance += base * classFactor * charFactor(char)
  }
  const withTracking = advance + letterSpacingMm * Math.max(0, [...text].length - 1)
  return roundMm(withTracking * weightFactor * styleFactor)
}

export function measureTextWidthPt(text: string, typography: TemplateTypography): number {
  return roundMm(measureTextMm(text, typography) / MM_PER_PT)
}

/** Height of one line, in mm, honouring the template's own line-height multiplier. */
export function lineHeightMm(typography: TemplateTypography): number {
  const multiplier = typography.lineHeight ?? 1.15
  return roundMm(typography.fontSizePt * multiplier * MM_PER_PT)
}

/**
 * A conservative shrink floor: below roughly 60% of the authored size the caption and the value
 * stop reading alike on pre-printed stock, so the engine clips and warns instead of shrinking
 * further. That is a deliberate product decision, not a rounding limit.
 */
export const MIN_FONT_SCALE = 0.6

export interface FitResult {
  readonly fits: boolean
  /** Font size that fits, which may equal the authored size. */
  readonly fontSizePt: number
  readonly scale: number
  readonly requiredWidthMm: number
  readonly availableWidthMm: number
}

/** Shrink-to-fit at font-size level (the only "shrink" a cheque printer should offer). */
export function fitTextToWidth(
  text: string,
  typography: TemplateTypography,
  availableWidthMm: number
): FitResult {
  // Half a micron of slack: `roundMm` on the measured width and `roundMm` on the authored box can
  // otherwise disagree by a thousandth of a millimetre and flip a fit decision, which would make a
  // layout hash depend on a rounding coin-flip rather than on the paper.
  const epsilon = 0.001
  const required = measureTextMm(text, typography)
  if (availableWidthMm <= 0 || required <= availableWidthMm + epsilon) {
    return {
      fits: required <= availableWidthMm + epsilon,
      fontSizePt: typography.fontSizePt,
      scale: 1,
      requiredWidthMm: required,
      availableWidthMm: roundMm(availableWidthMm),
    }
  }
  const rawScale = availableWidthMm / required
  const scale = Math.max(MIN_FONT_SCALE, rawScale)
  const fontSizePt = Math.round(typography.fontSizePt * scale * 100) / 100
  const shrunk = measureTextMm(text, { ...typography, fontSizePt })
  return {
    fits: shrunk <= availableWidthMm + epsilon,
    fontSizePt,
    scale,
    requiredWidthMm: roundMm(shrunk),
    availableWidthMm: roundMm(availableWidthMm),
  }
}
