/**
 * The registration test page (§8.5) — the artefact that turns "it looks right" into a number.
 *
 * Unlike a cheque template, a test page MAY draw rules and boxes: it is a measuring instrument
 * printed on scrap or on the real stock, not data placed on somebody else's artwork. It carries:
 *
 * - millimetre rulers on two edges (ticks every 10 mm, labels every 50 mm) to expose a scale error;
 * - corner and centre registration marks, which expose offset and skew in one glance;
 * - a crosshair at the centre of every printed field of the template, which is what tells you the
 *   payee line will land on the bank's pre-printed rule rather than 3 mm below it.
 *
 * Print it, measure it, feed the numbers to {@link deriveCalibration}. Printing
 * `transform` alongside the marks is the verification loop: with a correct calibration the marks
 * land on their expected coordinates again.
 */

import { hashCanonical } from '../canonical/hash'
import { roundMm, type MmExtent } from '../geometry/units'
import {
  buildStandaloneDocument,
  escapeHtml,
  pageCss,
  styleDeclarations,
  utf8ByteLength,
} from '../html/document'
import { transformPoint, type PrinterTransform } from './transform'

export type TestPageMarkKind = 'registration' | 'field-anchor' | 'ruler-tick' | 'ruler-label' | 'note'

export interface TestPageMark {
  readonly id: string
  readonly kind: TestPageMarkKind
  /** Where the operator expects the mark to land on paper — the target, not the drawing. */
  readonly expectedXMm: number
  readonly expectedYMm: number
  /** Where it is actually placed, after the current transform. Identical when uncalibrated. */
  readonly placedXMm: number
  readonly placedYMm: number
  readonly widthMm: number
  readonly heightMm: number
  readonly label?: string
  readonly fieldId?: string
}

export interface TestPageFieldAnchor {
  readonly fieldId: string
  readonly label: string
  readonly xMm: number
  readonly yMm: number
  readonly widthMm: number
  readonly heightMm: number
}

export interface BuildTestPageInput {
  readonly paper: MmExtent
  readonly profileId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly fieldAnchors?: readonly TestPageFieldAnchor[]
  readonly transform?: PrinterTransform
  readonly rulerStepMm?: number
  readonly rulerLabelStepMm?: number
  readonly marginMm?: number
  readonly measuredAt?: string
}

export interface TestPageSpec {
  readonly id: string
  readonly profileId: string
  readonly templateId: string
  readonly templateVersion: number
  readonly paper: MmExtent
  readonly marks: readonly TestPageMark[]
  readonly instructions: readonly string[]
  readonly generatedAt: string
  readonly calibrated: boolean
  readonly hash: string
}

const CORNER_INSET_MM = 8

export function buildRegistrationTestPage(input: BuildTestPageInput): TestPageSpec {
  const rulerStep = input.rulerStepMm ?? 10
  const labelStep = input.rulerLabelStepMm ?? 50
  const transform = input.transform ?? null
  const width = roundMm(input.paper.widthMm)
  const height = roundMm(input.paper.heightMm)
  const margin = input.marginMm ?? 0

  const marks: TestPageMark[] = []
  const place = (
    id: string,
    kind: TestPageMarkKind,
    xMm: number,
    yMm: number,
    widthMm: number,
    heightMm: number,
    label?: string,
    fieldId?: string
  ): void => {
    // The expected value already includes the page margin: it is what the operator measures from
    // the physical paper edge, so the comparison never needs a second arithmetic step by hand.
    const target = { xMm: roundMm(xMm + margin), yMm: roundMm(yMm + margin) }
    const placed = transform === null ? target : transformPoint(target, transform)
    marks.push({
      id,
      kind,
      expectedXMm: target.xMm,
      expectedYMm: target.yMm,
      placedXMm: placed.xMm,
      placedYMm: placed.yMm,
      widthMm,
      heightMm,
      ...(label === undefined ? {} : { label }),
      ...(fieldId === undefined ? {} : { fieldId }),
    })
  }

  // Rulers: ticks along the top edge and the left edge.
  for (let x = 0; x <= width + 0.001; x += rulerStep) {
    const label = Number(x.toFixed(3))
    place(`tick-x-${String(label)}`, 'ruler-tick', label, 2, 0.2, 3)
    if (label % labelStep === 0 && label > 0) {
      place(`label-x-${String(label)}`, 'ruler-label', label - 4, 5.2, 8, 4, `${String(label)}mm`)
    }
  }
  for (let y = 0; y <= height + 0.001; y += rulerStep) {
    const label = Number(y.toFixed(3))
    place(`tick-y-${String(label)}`, 'ruler-tick', 2, label, 3, 0.2)
    if (label % labelStep === 0 && label > 0) {
      place(`label-y-${String(label)}`, 'ruler-label', 5.2, label - 2, 10, 4, `${String(label)}mm`)
    }
  }

  // Registration marks: four corners plus the centre. Offset shows as a uniform shift of all five,
  // skew as the pair on one edge tracking higher or lower than the other.
  const corners: readonly (readonly [number, number])[] = [
    [CORNER_INSET_MM, CORNER_INSET_MM],
    [width - CORNER_INSET_MM, CORNER_INSET_MM],
    [CORNER_INSET_MM, height - CORNER_INSET_MM],
    [width - CORNER_INSET_MM, height - CORNER_INSET_MM],
    [width / 2, height / 2],
  ]
  corners.forEach(([x, y], index) => {
    place(`registration-${String(index)}`, 'registration', roundMm(x), roundMm(y), 4, 4, `R${String(index + 1)}`)
  })

  for (const anchor of input.fieldAnchors ?? []) {
    const centreX = roundMm(anchor.xMm + anchor.widthMm / 2)
    const centreY = roundMm(anchor.yMm + anchor.heightMm / 2)
    place(
      `anchor-${anchor.fieldId}`,
      'field-anchor',
      centreX,
      centreY,
      roundMm(anchor.widthMm),
      roundMm(anchor.heightMm),
      anchor.label,
      anchor.fieldId
    )
  }

  const instructions: string[] = [
    `Print at 100% with no driver scaling ("actual size" / "fit page" off) on the ${input.templateId} stock, single-sided, colour off.`,
    'Measure the distance between the first and last visible ruler tick in each direction with a steel rule, not a tape.',
    'For every R1–R5 registration mark, measure from the printed paper edge to the mark centre, horizontally and vertically.',
    'Check each field crosshair against the bank caption it must land on: a crosshair that misses the pre-printed rule is the number that matters most.',
    'Enter the measured values; the system derives offset, scale and skew and reports the residual error in millimetres.',
    'Print the page again after calibration: marks must land on their expected coordinates within 0.5 mm.',
  ]
  if (transform === null) {
    instructions.push('This page carries no transform at all: every mark is printed exactly where the template says the content should land.')
  } else if (transform.calibration === null) {
    instructions.push('This page is uncalibrated: only the printer profile\'s nominal offsets were applied, so read it as a starting guess, not as a measurement.')
  } else {
    instructions.push(`This page carries the current transform (${transform.profile.name}); identical measured and expected values mean the calibration is holding.`)
  }

  const withoutHash: Omit<TestPageSpec, 'hash'> = {
    id: `testpage:${input.profileId}:${input.templateId}:v${String(input.templateVersion)}`,
    profileId: input.profileId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    paper: { widthMm: width, heightMm: height },
    marks,
    instructions,
    generatedAt: input.measuredAt ?? new Date().toISOString(),
    calibrated: transform?.calibration != null,
  }
  return Object.freeze({ ...withoutHash, hash: hashCanonical(withoutHash) })
}

export interface RenderedTestPage {
  readonly html: string
  readonly bytes: number
  readonly hash: string
  readonly markCount: number
}

export function renderTestPageDocument(spec: TestPageSpec): RenderedTestPage {
  const css = [
    pageCss({ widthMm: spec.paper.widthMm, heightMm: spec.paper.heightMm, marginMm: 0 }),
    '.mark { position: absolute; }',
    '.tick { background: #000; }',
    '.cross::before, .cross::after { content: ""; position: absolute; background: #000; }',
    '.cross::before { left: 0; top: 50%; width: 100%; height: 0.2mm; }',
    '.cross::after { left: 50%; top: 0; width: 0.2mm; height: 100%; }',
    '.box { border: 0.15mm solid #000; }',
    '.lbl { font: 6pt/1 monospace; color: #000; }',
    '@media screen { body { outline: 1px solid #ccc; } }',
  ].join('\n')

  const body: string[] = []
  for (const mark of spec.marks) {
    const style = styleDeclarations({
      left: `${String(mark.placedXMm)}mm`,
      top: `${String(mark.placedYMm)}mm`,
      width: `${String(mark.widthMm)}mm`,
      height: `${String(mark.heightMm)}mm`,
    })
    if (mark.kind === 'ruler-tick') {
      body.push(`<div class="mark tick" style="${style}"></div>`)
      continue
    }
    if (mark.kind === 'ruler-label') {
      body.push(`<div class="mark lbl" style="${style}">${escapeHtml(mark.label ?? '')}</div>`)
      continue
    }
    if (mark.kind === 'field-anchor') {
      const label = escapeHtml(mark.label ?? mark.fieldId ?? '')
      // The mark is anchored at the field's centre, so the outline is drawn back out from it.
      const boxStyle = styleDeclarations({
        left: `${String(roundMm(mark.placedXMm - mark.widthMm / 2))}mm`,
        top: `${String(roundMm(mark.placedYMm - mark.heightMm / 2))}mm`,
        width: `${String(mark.widthMm)}mm`,
        height: `${String(mark.heightMm)}mm`,
      })
      body.push(
        `<div class="mark box" style="${boxStyle}"></div>` +
          `<div class="mark cross" style="${styleDeclarations({
            left: `${String(mark.placedXMm - 2)}mm`,
            top: `${String(mark.placedYMm - 2)}mm`,
            width: '4mm',
            height: '4mm',
          })}"></div>` +
          `<div class="mark lbl" style="${styleDeclarations({
            left: `${String(mark.placedXMm + 2.5)}mm`,
            top: `${String(mark.placedYMm - 2)}mm`,
            width: `${String(Math.max(20, mark.widthMm))}mm`,
            height: '3mm',
          })}">${label}</div>`
      )
      continue
    }
    body.push(
      `<div class="mark cross" style="${style}"></div>` +
        `<div class="mark lbl" style="${styleDeclarations({
          left: `${String(mark.placedXMm + 2.5)}mm`,
          top: `${String(mark.placedYMm - 1.5)}mm`,
          width: '20mm',
          height: '3mm',
        })}">${escapeHtml(mark.label ?? '')} @ ${String(mark.expectedXMm)},${String(mark.expectedYMm)}</div>`
    )
  }

  const html = buildStandaloneDocument({
    title: `PrintChecks calibration test page — ${spec.profileId} / ${spec.templateId}`,
    lang: 'en',
    direction: 'ltr',
    css,
    body: body.join('\n'),
    meta: {
      documentKind: 'calibration-test-page',
      templateId: spec.templateId,
      templateVersion: spec.templateVersion,
      layoutHash: spec.hash,
      runCount: spec.marks.length,
    },
  })

  return Object.freeze({ html, bytes: utf8ByteLength(html), hash: spec.hash, markCount: spec.marks.length })
}

/** The worksheet the operator fills in by hand — printed as HTML text on the page itself. */
export function measurementTable(spec: TestPageSpec): {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
} {
  return {
    columns: ['mark', 'expected x mm', 'expected y mm', 'measured x mm', 'measured y mm'],
    rows: spec.marks
      .filter((mark) => mark.kind === 'registration' || mark.kind === 'field-anchor')
      .map((mark) => [
        mark.id,
        String(mark.expectedXMm),
        String(mark.expectedYMm),
        '',
        '',
      ]),
  }
}
