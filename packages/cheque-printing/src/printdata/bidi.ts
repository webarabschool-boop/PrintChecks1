/**
 * Bidirectional text support — LTR, RTL and genuinely mixed content.
 *
 * Egyptian and most Arab-League cheque stocks are RTL documents whose *data* is mixed: an Arabic
 * payee name, a Latin cheque number, Latin digits in the amount box, sometimes an English drawer
 * block. A layout engine that only understands LTR either reverses the Arabic or mangles the
 * numbers.
 *
 * The implementation is an explicit, documented subset of UAX #9 rather than a full bidi
 * algorithm: the *first strong character* decides the base direction of a run, neutrals (spaces,
 * punctuation) inherit their run, and digit sequences are isolated so a Latin number inside an
 * Arabic line never reorders. That is enough for cheque fields — each of which is one short line,
 * not a paragraph — and it is testable in bare Node with no browser bidi engine involved.
 */

import type { TextDirection } from '../template/types'

/** Arabic block, Arabic Supplement, Extended-A, and the presentation forms used on stock forms. */
const ARABIC_RANGES: readonly (readonly [number, number])[] = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
]

const HEBREW_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x05ff],
  [0xfb1d, 0xfb4f],
]

/** ASCII digits and Arabic-Indic digits both count as "European/AN digits", i.e. weak LTR. */
const LATIN_DIGITS: readonly (readonly [number, number])[] = [[0x30, 0x39]]
const ARABIC_INDIC_DIGITS: readonly (readonly [number, number])[] = [[0x0660, 0x0669]]
const EXTENDED_ARABIC_INDIC_DIGITS: readonly (readonly [number, number])[] = [[0x06f0, 0x06f9]]

export type CharClass = 'strong-ltr' | 'strong-rtl' | 'digit' | 'neutral'

export function charClassOf(codePoint: number): CharClass {
  // Digits first: the Arabic block *contains* Arabic-Indic digits, and a digit is weak in every
  // bidi model, wherever it comes from. Getting this order wrong makes an amount box RTL.
  if (inRanges(codePoint, LATIN_DIGITS)) return 'digit'
  if (inRanges(codePoint, ARABIC_INDIC_DIGITS)) return 'digit'
  if (inRanges(codePoint, EXTENDED_ARABIC_INDIC_DIGITS)) return 'digit'
  if (inRanges(codePoint, ARABIC_RANGES)) return 'strong-rtl'
  if (inRanges(codePoint, HEBREW_RANGES)) return 'strong-rtl'
  // Only ASCII *letters* are strong LTR. Punctuation, spaces and symbols are neutral, so they
  // ride with their surrounding run instead of silently flipping a line to LTR.
  if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
    return 'strong-ltr'
  }
  if (codePoint > 0x7f) {
    return isStrongLetter(codePoint) ? 'strong-ltr' : 'neutral'
  }
  return 'neutral'
}

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [lo, hi] of ranges) {
    if (codePoint >= lo && codePoint <= hi) return true
  }
  return false
}

function isStrongLetter(codePoint: number): boolean {
  // Deliberately coarse: letters outside the RTL blocks above are treated as LTR. Punctuation,
  // spaces, combining marks and format characters fall through to 'neutral'.
  return (
    (codePoint >= 0x00c0 && codePoint <= 0x024f) ||
    (codePoint >= 0x0370 && codePoint <= 0x03ff) ||
    (codePoint >= 0x0400 && codePoint <= 0x04ff) ||
    (codePoint >= 0x1e00 && codePoint <= 0x1fff) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff)
  )
}

export interface BidiSegment {
  readonly text: string
  readonly direction: 'ltr' | 'rtl'
  /** True for isolated digit runs — they must never be reordered by the caller. */
  readonly isNumeric: boolean
}

export interface BidiAnalysis {
  readonly baseDirection: 'ltr' | 'rtl'
  readonly segments: readonly BidiSegment[]
  readonly isMixed: boolean
  readonly hasArabic: boolean
  readonly hasHebrew: boolean
  readonly hasLatinDigits: boolean
  readonly hasArabicIndicDigits: boolean
}

/**
 * First-strong base direction, falling back to the supplied default when the text is entirely
 * neutral (e.g. `'----'` or a whitespace-only memo), which is exactly when a template's own
 * direction should win.
 */
export function detectBaseDirection(
  text: string,
  fallback: 'ltr' | 'rtl' = 'ltr'
): 'ltr' | 'rtl' {
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue
    const kind = charClassOf(codePoint)
    if (kind === 'strong-rtl') return 'rtl'
    if (kind === 'strong-ltr') return 'ltr'
  }
  return fallback
}

export function analyseText(text: string, fallback: 'ltr' | 'rtl' = 'ltr'): BidiAnalysis {
  const baseDirection = detectBaseDirection(text, fallback)
  const segments: BidiSegment[] = []
  let current = ''
  let currentKind: CharClass | null = null

  const flush = () => {
    if (current.length === 0) return
    segments.push({
      text: current,
      direction: currentKind === 'strong-rtl' ? 'rtl' : 'ltr',
      isNumeric: currentKind === 'digit',
    })
    current = ''
  }

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    const kind = charClassOf(codePoint)
    // Neutrals belong to the segment they sit in; digits start their own isolated segment.
    if (kind === 'neutral') {
      current += char
      continue
    }
    if (currentKind === null) {
      currentKind = kind
      current += char
      continue
    }
    const groupsTogether =
      (currentKind === 'digit' && kind === 'digit') ||
      (currentKind !== 'digit' && kind === currentKind)
    if (groupsTogether) {
      current += char
    } else {
      flush()
      currentKind = kind
      current = char
    }
  }
  flush()

  const normalized = segments.map((segment) => normalizeSegmentDirection(segment, baseDirection))
  const directions = new Set(normalized.map((segment) => segment.direction))

  return {
    baseDirection,
    segments: normalized,
    isMixed: directions.size > 1,
    hasArabic: containsClass(text, ARABIC_RANGES),
    hasHebrew: containsClass(text, HEBREW_RANGES),
    hasLatinDigits: /[0-9]/.test(text),
    hasArabicIndicDigits: /[\u0660-\u0669\u06f0-\u06f9]/.test(text),
  }
}

function normalizeSegmentDirection(segment: BidiSegment, baseDirection: 'ltr' | 'rtl'): BidiSegment {
  if (segment.text.trim().length === 0) {
    // A neutral-only segment (spaces, dashes) rides with the base direction.
    return { ...segment, direction: baseDirection }
  }
  return segment
}

function containsClass(text: string, ranges: readonly (readonly [number, number])[]): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && inRanges(codePoint, ranges)) return true
  }
  return false
}

/**
 * Resolve the direction of one field run: the template's per-field setting wins, `'auto'` derives
 * it from the content, and an explicit data-level hint (from the cheque, not the stock) overrides
 * both. This is what lets one template serve an Arabic and an English payee correctly.
 */
export function resolveFieldDirection(
  content: string,
  fieldDirection: TextDirection | undefined,
  templateDefault: 'ltr' | 'rtl',
  dataHint?: 'ltr' | 'rtl' | 'auto'
): 'ltr' | 'rtl' {
  if (dataHint === 'ltr' || dataHint === 'rtl') return dataHint
  if (fieldDirection === 'ltr' || fieldDirection === 'rtl') return fieldDirection
  return detectBaseDirection(content, templateDefault)
}

const FIRST_ISOLATE = '\u2066' // FSI — first strong override for the embedded run
const POP_ISOLATE = '\u2069' // PDI

/**
 * Wrap a numeric or foreign-direction run in bidi isolates so a Latin cheque number inside an
 * Arabic line prints in the right order regardless of the surrounding paragraph direction.
 * Idempotent, and a no-op when there is nothing to isolate.
 */
export function isolateRun(text: string, runDirection: 'ltr' | 'rtl', baseDirection: 'ltr' | 'rtl'): string {
  if (text.length === 0 || runDirection === baseDirection) return text
  if (text.startsWith(FIRST_ISOLATE) && text.endsWith(POP_ISOLATE)) return text
  return `${FIRST_ISOLATE}${text}${POP_ISOLATE}`
}

export function stripBidiControls(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
}

export function hasBidiControls(text: string): boolean {
  return /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(text)
}

/**
 * Convert Latin digits to Arabic-Indic digits (or back) for stocks whose amount box is
 * pre-printed with Arabic-Indic placeholders. Off by default: never silently rewrite a number.
 */
export function convertDigits(text: string, target: 'latin' | 'arabic-indic'): string {
  if (target === 'arabic-indic') {
    return text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)))
  }
  return text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => {
    const code = digit.charCodeAt(0)
    const offset = code >= 0x06f0 ? 0x06f0 : 0x0660
    return String(code - offset)
  })
}

/**
 * Isolate every run whose direction opposes the base direction of the line. This is the single
 * place where invisible formatting characters are added to printable text, and only for mixed
 * content: a pure-Arabic or pure-English line is returned unchanged, byte for byte.
 */
export function applyBidiIsolation(text: string, baseDirection: 'ltr' | 'rtl'): string {
  if (text.length === 0) return text
  // Strip first, so calling this on text that is already isolated reproduces it exactly rather
  // than nesting another layer of isolates around the existing ones.
  const stripped = hasBidiControls(text) ? stripBidiControls(text) : text
  if (stripped.length === 0) return stripped
  const analysis = analyseText(stripped, baseDirection)
  if (!analysis.isMixed) return text
  let out = ''
  for (const segment of analysis.segments) {
    out +=
      segment.direction === baseDirection
        ? segment.text
        : isolateRun(segment.text, segment.direction, baseDirection)
  }
  return out
}
