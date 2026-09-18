/**
 * Greedy line wrapping against the estimator in `measure.ts`.
 *
 * Greedy rather than optimal (Knuth–Plass) on purpose: a cheque field is one or two short lines, and
 * a deterministic greedy pass is what makes the layout reproducible on any machine. Justified text is
 * never wanted here — a cheque line is left- or right-aligned against a pre-printed rule.
 */

import { roundMm } from '../geometry/units'
import type { TemplateTypography } from '../template/types'
import { measureTextMm } from './measure'

export interface WrapResult {
  readonly lines: string[]
  /** Words that had to be broken across a line because they alone exceed the width. */
  readonly hardBroken: boolean
  readonly widthExceeded: boolean
}

export function wrapText(text: string, typography: TemplateTypography, maxWidthMm: number): WrapResult {
  if (text.trim() === '') return { lines: [''], hardBroken: false, widthExceeded: false }
  const words = text.split(/(\s+)/).filter((word) => word.length > 0)

  const lines: string[] = []
  let current = ''
  let hardBroken = false

  const pushCurrent = () => {
    if (current !== '') lines.push(current)
    current = ''
  }

  for (const word of words) {
    const candidate = current + word
    const candidateWidth = measureTextMm(candidate.trimEnd(), typography)
    if (candidateWidth <= maxWidthMm || current === '') {
      if (measureTextMm(word.trim(), typography) > maxWidthMm && current === '') {
        // A single word wider than the field: break it rather than print beyond the paper.
        const pieces = breakWord(word.trim(), typography, maxWidthMm)
        if (pieces.length > 1) hardBroken = true
        for (const [index, piece] of pieces.entries()) {
          if (index < pieces.length - 1) lines.push(piece)
          else current = piece
        }
        continue
      }
      current = candidate
      continue
    }
    pushCurrent()
    current = word.trimStart()
  }
  pushCurrent()

  const overflow = lines.some((line) => measureTextMm(line, typography) > maxWidthMm + 0.01)
  return { lines: lines.length > 0 ? lines.map((line) => line.trimEnd()) : [''], hardBroken, widthExceeded: overflow }
}

function breakWord(word: string, typography: TemplateTypography, maxWidthMm: number): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const char of word) {
    if (piece !== '' && measureTextMm(piece + char, typography) > maxWidthMm) {
      pieces.push(piece)
      piece = char
      continue
    }
    piece += char
  }
  if (piece !== '') pieces.push(piece)
  return pieces.length > 0 ? pieces : [word]
}

export interface StackInput {
  readonly boxTopMm: number
  readonly boxHeightMm: number
  readonly lineHeightMm: number
  readonly lineCount: number
  readonly vertical: 'top' | 'middle' | 'bottom' | 'baseline'
}

/** Where each wrapped line starts, and how much the block overflows the field box. */
export function stackLines(input: StackInput): { readonly firstLineTopMm: number; readonly overflowMm: number } {
  const blockHeight = roundMm(input.lineHeightMm * input.lineCount)
  const overflowMm = roundMm(Math.max(0, blockHeight - input.boxHeightMm))
  let firstLineTopMm = input.boxTopMm
  if (input.vertical === 'middle') {
    firstLineTopMm = roundMm(input.boxTopMm + (input.boxHeightMm - blockHeight) / 2)
  } else if (input.vertical === 'bottom' || input.vertical === 'baseline') {
    firstLineTopMm = roundMm(input.boxTopMm + input.boxHeightMm - blockHeight)
  }
  return { firstLineTopMm, overflowMm }
}
