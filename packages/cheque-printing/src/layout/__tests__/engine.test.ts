import { describe, expect, it } from 'vitest'
import { roundMm } from '../../geometry/units'
import { createChequePrintData, type ChequePrintData } from '../../printdata'
import type { AmountInWordsConverter, AmountInWordsRequest, AmountInWordsResult } from '../../ports/amountInWords'
import {
  createBankChequeTemplate,
  createTemplateField,
  type BankChequeTemplate,
  type CreateTemplateFieldInput,
  type CreateTemplateInput,
} from '../../template'
import { buildPrintLayout } from '../engine'
import type { PlacedGlyphRun } from '../types'

const PAYEE: CreateTemplateFieldInput = {
  id: 'payee',
  key: 'payee',
  label: 'Pay to the order of',
  role: 'value',
  xMm: 10,
  yMm: 30,
  widthMm: 110,
  heightMm: 8,
  fontSizePt: 12,
  fontFamily: 'Times New Roman',
  source: 'payeeName',
  required: true,
  zIndex: 2,
}

const AMOUNT: CreateTemplateFieldInput = {
  id: 'amount-numeric',
  key: 'amountNumeric',
  label: 'Amount',
  role: 'value',
  xMm: 140,
  yMm: 42,
  widthMm: 45,
  heightMm: 8,
  fontSizePt: 11,
  fontFamily: 'Times New Roman',
  source: 'amountDecimal',
  format: 'amount-2dp',
  alignment: { horizontal: 'right', vertical: 'middle' },
  required: true,
  zIndex: 3,
}

const BASE_INPUT: CreateTemplateInput = {
  id: 'fixture-cheque',
  bankId: 'bank:fixture',
  bankName: 'Fixture Bank',
  name: 'Fixture personal cheque',
  stockType: 'personal',
  paper: {
    widthMm: 200,
    heightMm: 90,
    orientation: 'landscape',
    bodyOriginMm: { xMm: 0, yMm: 0 },
    bodyWidthMm: 190,
    bodyHeightMm: 78,
  },
  fields: [PAYEE, AMOUNT],
}

/** Always built through the factory, so every field is a normalised, frozen `TemplateField`. */
function template(overrides: Partial<CreateTemplateInput> = {}): BankChequeTemplate {
  return createBankChequeTemplate({ ...BASE_INPUT, ...overrides })
}

function data(overrides: Partial<ChequePrintData> = {}): ChequePrintData {
  return createChequePrintData({
    chequeNumber: '001234',
    date: '2026-09-18',
    payeeName: 'Crescent Trading',
    amountDecimal: '1500.00',
    currency: 'EGP',
    ...overrides,
  })
}

const wordsConverter = (words: string = 'one thousand five hundred pounds only'): AmountInWordsConverter => ({
  id: 'fixture-converter',
  supportedLocales: ['en', 'ar'],
  convert(request: AmountInWordsRequest): AmountInWordsResult {
    return {
      words: request.uppercase === true ? words.toUpperCase() : words,
      converterId: 'fixture-converter',
      usedLocale: request.locale,
    }
  },
})

const runOf = (layout: { runs: readonly PlacedGlyphRun[] }, fieldId: string): PlacedGlyphRun => {
  const run = layout.runs.find((candidate) => candidate.fieldId === fieldId)
  if (run === undefined) throw new Error(`no run for field "${fieldId}"`)
  return run
}

const codes = (layout: { warnings: readonly { code: string }[] }) => layout.warnings.map((warning) => warning.code)

describe('layout engine — the deterministic core', () => {
  it('emits one run per printed field, and keeps guides out of the ink', () => {
    const withGuides = template({
      fields: [
        PAYEE,
        AMOUNT,
        createTemplateField({
          id: 'micr-guide',
          key: 'micr',
          label: 'MICR band',
          role: 'guide',
          xMm: 10,
          yMm: 74,
          widthMm: 160,
          heightMm: 9,
          isPrinted: false,
          zIndex: 0,
        }),
      ],
    })
    const layout = buildPrintLayout({ template: withGuides, data: data() })
    expect(layout.runs.map((run) => run.fieldId).sort()).toEqual(['amount-numeric', 'payee'])
    expect(layout.guides.map((run) => run.fieldId)).toEqual(['micr-guide'])
    expect(layout.runCount).toBe(2)
    expect(layout.blocked).toBe(false)
    const noGuides = buildPrintLayout({ template: withGuides, data: data(), options: { includeGuides: false } })
    expect(noGuides.guides).toEqual([])
    expect(noGuides.runs).toHaveLength(2)
  })

  it('is a pure function: the same inputs give the same layoutHash, twice in a row', () => {
    const t = template()
    const d = data()
    const first = buildPrintLayout({ template: t, data: d })
    const second = buildPrintLayout({ template: t, data: d })
    expect(first.layoutHash).toBe(second.layoutHash)
    expect(first).toEqual(second)
  })

  it('changes the hash when the value changes, and when a field moves by a millimetre', () => {
    const t = template()
    const asPrinted = buildPrintLayout({ template: t, data: data() }).layoutHash
    expect(buildPrintLayout({ template: t, data: data({ payeeName: 'Crescent Trading Ltd' }) }).layoutHash).not.toBe(asPrinted)
    const moved = template({ fields: [{ ...PAYEE, xMm: PAYEE.xMm + 1 }, AMOUNT] })
    expect(buildPrintLayout({ template: moved, data: data() }).layoutHash).not.toBe(asPrinted)
  })

  it('paints in zIndex order no matter what order the designer listed the fields in', () => {
    const built = template()
    // Re-ordering the table in the designer must not change what prints — only the published
    // template's own hash moves, and the runs come out identical either way.
    const reordered: BankChequeTemplate = { ...built, fields: [...built.fields].reverse() }
    const a = buildPrintLayout({ template: built, data: data() })
    const b = buildPrintLayout({ template: reordered, data: data() })
    expect(b.runs.map((run) => run.fieldId)).toEqual(a.runs.map((run) => run.fieldId))
    expect(b.layoutHash).toBe(a.layoutHash)
    expect(a.runs.map((run) => run.fieldId)).toEqual(['payee', 'amount-numeric'])
  })

  it('reports the paper it was laid out for, and the template identity it pins', () => {
    const t = template()
    const layout = buildPrintLayout({ template: t, data: data() })
    expect(layout.paper).toEqual({ widthMm: 200, heightMm: 90, orientation: 'landscape' })
    expect(layout.templateId).toBe('fixture-cheque')
    expect(layout.templateVersion).toBe(1)
    expect(layout.templateHash).toBe(t.templateHash)
    expect(layout.direction).toBe('ltr')
    expect(layout.locale).toBe('en-US')
    expect(Object.isFrozen(layout)).toBe(true)
  })

  it('places runs in millimetres from the sheet, using the body offset as the datum', () => {
    const t = template({
      paper: {
        widthMm: 200,
        heightMm: 168,
        orientation: 'landscape',
        bodyOriginMm: { xMm: 5, yMm: 80 },
        bodyWidthMm: 190,
        bodyHeightMm: 78,
      },
    })
    const layout = buildPrintLayout({ template: t, data: data() })
    expect(runOf(layout, 'payee').xMm).toBe(15)
    expect(runOf(layout, 'payee').yMm).toBe(110)
    expect(runOf(layout, 'payee').widthMm).toBe(110)
  })

  it('resolves the amount box to the right-hand edge of its field, not the left', () => {
    const layout = buildPrintLayout({ template: template(), data: data() })
    const run = runOf(layout, 'amount-numeric')
    const line = run.lines[0]
    expect(line).toBeDefined()
    expect(run.alignH).toBe('right')
    expect(roundMm(line!.xMm + line!.widthMm)).toBe(roundMm(run.xMm + run.widthMm))
    // A left-aligned payee starts at its box edge.
    expect(runOf(layout, 'payee').lines[0]?.xMm).toBe(runOf(layout, 'payee').xMm)
  })

  it('applies the format declared on the field, through the shared formatters', () => {
    const t = template({
      fields: [
        PAYEE,
        createTemplateField({ ...AMOUNT, format: undefined }),
        createTemplateField({
          id: 'date',
          key: 'date',
          label: 'Date',
          xMm: 140,
          yMm: 10,
          widthMm: 40,
          heightMm: 7,
          format: 'date-DDMMYYYY',
          zIndex: 1,
        }),
        createTemplateField({
          id: 'number',
          key: 'chequeNumber',
          label: 'Cheque number',
          xMm: 10,
          yMm: 10,
          widthMm: 30,
          heightMm: 6,
          format: 'number-padded',
          zIndex: 1,
        }),
      ],
    })
    const layout = buildPrintLayout({ template: t, data: data({ chequeNumber: '42' }) })
    expect(runOf(layout, 'date').sourceText).toBe('18/09/2026')
    expect(runOf(layout, 'number').sourceText).toBe('000042')
    expect(runOf(layout, 'amount-numeric').sourceText).toBe('1500.00')
  })

  it('upper-cases only when the template asks it to', () => {
    const t = template({ fields: [createTemplateField({ ...PAYEE, textTransform: 'uppercase' }), AMOUNT] })
    expect(runOf(buildPrintLayout({ template: t, data: data() }), 'payee').sourceText).toBe('CRESCENT TRADING')
  })

  it('reads a custom key out of the payload', () => {
    const t = template({
      fields: [
        PAYEE,
        AMOUNT,
        createTemplateField({
          id: 'branch',
          key: 'branch-code',
          label: 'Branch',
          xMm: 10,
          yMm: 70,
          widthMm: 30,
          heightMm: 6,
          source: 'custom',
          customKey: 'branch',
          zIndex: 1,
        }),
      ],
    })
    const layout = buildPrintLayout({ template: t, data: data({ custom: { branch: 'Nasr City 011' } }) })
    expect(runOf(layout, 'branch').sourceText).toBe('Nasr City 011')
  })
})

describe('layout engine — pre-printed stock (T3)', () => {
  const captionTemplate = template({
    fields: [
      PAYEE,
      AMOUNT,
      createTemplateField({
        id: 'payee-caption',
        key: 'payee',
        label: 'Pay to the order of',
        role: 'caption',
        xMm: 10,
        yMm: 24,
        widthMm: 60,
        heightMm: 5,
        zIndex: 1,
      }),
    ],
  })

  it('drops a caption the bank already printed, and reports the drop', () => {
    const layout = buildPrintLayout({ template: captionTemplate, data: data() })
    expect(layout.suppressedFields).toEqual(['payee-caption'])
    expect(codes(layout)).toContain('FIELD_SUPPRESSED_BY_PREPRINTED')
    expect(layout.runs.map((run) => run.fieldId)).not.toContain('payee-caption')
  })

  it('prints the caption when the stock is flagged as blank paper', () => {
    const blank = template({
      fields: captionTemplate.fields,
      preprinted: { ...createBankChequeTemplate(BASE_INPUT).preprinted, hasPayeeCaption: false },
    })
    const layout = buildPrintLayout({ template: blank, data: data() })
    expect(layout.suppressedFields).toEqual([])
    expect(layout.runs.map((run) => run.fieldId)).toContain('payee-caption')
  })
})

describe('layout engine — bidi on the printed text', () => {
  const arabicTemplate = template({ defaultDirection: 'rtl' })

  it('sets the run direction from the content and the stock', () => {
    const layout = buildPrintLayout({ template: arabicTemplate, data: data({ payeeName: 'شركة الهلال للتجارة' }) })
    const run = runOf(layout, 'payee')
    expect(run.direction).toBe('rtl')
    expect(run.isMixedDirection).toBe(false)
    expect(run.text).toBe('شركة الهلال للتجارة')
  })

  it('isolates a Latin name inside an Arabic line, and keeps a clean copy for the audit', () => {
    const layout = buildPrintLayout({
      template: arabicTemplate,
      data: data({ payeeName: 'شركة الهلال — Crescent Trading' }),
    })
    const run = runOf(layout, 'payee')
    expect(run.isMixedDirection).toBe(true)
    expect(run.text).toContain('\u2066')
    expect(run.sourceText).not.toContain('\u2066')
    expect(run.segments.some((segment) => segment.direction === 'ltr')).toBe(true)
  })

  it('lets the payload override the direction for one cheque', () => {
    const layout = buildPrintLayout({ template: arabicTemplate, data: data({ directionHint: 'ltr' }) })
    expect(runOf(layout, 'payee').direction).toBe('ltr')
  })
})

describe('layout engine — refusing to print something wrong', () => {
  it('blocks when a field the template requires carries no value', () => {
    // A stock that insists on a memo line, printed from a cheque whose memo is null: the payload is
    // legitimate, the template is the thing that cannot be satisfied.
    const demanding = template({
      fields: [PAYEE, AMOUNT, createTemplateField({ ...PAYEE, id: 'memo', key: 'memo', label: 'Memo', source: 'memo', yMm: 70, heightMm: 6, widthMm: 40, required: true, zIndex: 1 })],
    })
    const layout = buildPrintLayout({ template: demanding, data: data() })
    expect(codes(layout)).toContain('REQUIRED_FIELD_EMPTY')
    expect(layout.blocked).toBe(true)
  })

  it('warns, without blocking, when an optional field is empty', () => {
    const optional = template({
      fields: [PAYEE, AMOUNT, createTemplateField({ ...PAYEE, id: 'memo', key: 'memo', label: 'Memo', source: 'memo', yMm: 70, heightMm: 6, widthMm: 40, required: false, zIndex: 1 })],
    })
    const layout = buildPrintLayout({ template: optional, data: data() })
    expect(codes(layout)).toContain('FIELD_VALUE_EMPTY')
    expect(layout.blocked).toBe(false)
  })

  it('blocks a printed MICR field, because this phase emits no magnetic ink (T5)', () => {
    const micr = template({
      fields: [
        PAYEE,
        createTemplateField({
          id: 'micr',
          key: 'chequeNumber',
          label: 'MICR band',
          xMm: 10,
          yMm: 74,
          widthMm: 160,
          heightMm: 9,
          isMicr: true,
          source: 'chequeNumber',
        }),
      ],
    })
    const layout = buildPrintLayout({ template: micr, data: data() })
    expect(codes(layout)).toContain('FIELD_MICR_NOT_PRINTABLE')
    expect(layout.blocked).toBe(true)
    expect(layout.runs.map((run) => run.fieldId)).not.toContain('micr')
  })

  it('blocks a field bound to the signature: a human signs a cheque', () => {
    const signed = template({
      fields: [
        PAYEE,
        AMOUNT,
        createTemplateField({
          id: 'signature-line',
          key: 'signature',
          label: 'Drawer signature',
          xMm: 140,
          yMm: 66,
          widthMm: 45,
          heightMm: 8,
          source: 'signature',
          required: false,
        }),
      ],
    })
    const layout = buildPrintLayout({ template: signed, data: data() })
    expect(codes(layout)).toContain('FIELD_SIGNATURE_NOT_PRINTABLE')
    expect(layout.blocked).toBe(true)
  })

  it('blocks a field whose source cannot be resolved', () => {
    const broken = template({
      fields: [
        PAYEE,
        AMOUNT,
        createTemplateField({
          id: 'cnp',
          key: 'cnp',
          label: 'CNP',
          xMm: 10,
          yMm: 70,
          widthMm: 40,
          heightMm: 6,
          source: 'custom',
        }),
        createTemplateField({
          id: 'no-source',
          key: 'branch-code',
          label: 'Branch',
          xMm: 10,
          yMm: 78,
          widthMm: 40,
          heightMm: 6,
        }),
      ],
    })
    const layout = buildPrintLayout({ template: broken, data: data() })
    expect(codes(layout)).toContain('FIELD_UNRESOLVED_SOURCE')
    expect(layout.warnings.filter((warning) => warning.code === 'FIELD_UNRESOLVED_SOURCE')).toHaveLength(2)
    expect(layout.blocked).toBe(true)
  })

  it('blocks a run that lands off the sheet', () => {
    const offPage = template({ fields: [{ ...PAYEE, xMm: 195, widthMm: 20 }, AMOUNT] })
    const layout = buildPrintLayout({ template: offPage, data: data() })
    expect(codes(layout)).toContain('FIELD_OUTSIDE_PAPER')
    expect(layout.blocked).toBe(true)
  })

  it('warns about a field that prints on the counterfoil, outside the body', () => {
    const stub = template({
      paper: {
        widthMm: 200,
        heightMm: 90,
        orientation: 'landscape',
        bodyOriginMm: { xMm: 0, yMm: 0 },
        bodyWidthMm: 100,
        bodyHeightMm: 78,
      },
      fields: [PAYEE, { ...AMOUNT, xMm: 150 }],
    })
    const layout = buildPrintLayout({ template: stub, data: data() })
    expect(codes(layout)).toContain('FIELD_OUTSIDE_BODY')
    expect(layout.blocked).toBe(false)
  })

  it('flags a stock that prints no cheque number at all', () => {
    const layout = buildPrintLayout({ template: template(), data: data() })
    expect(codes(layout)).toContain('CHEQUE_NUMBER_NOT_PRINTED')
  })

  it('blocks two runs whose boxes collide, and tolerates a quarter-millimetre kiss', () => {
    const overlapping = template({ fields: [PAYEE, { ...AMOUNT, xMm: 100, yMm: 30, widthMm: 60, heightMm: 8, format: undefined }] })
    const layout = buildPrintLayout({ template: overlapping, data: data() })
    expect(codes(layout)).toContain('FIELD_COLLISION')
    expect(layout.blocked).toBe(true)

    const kissing = template({ fields: [PAYEE, { ...AMOUNT, xMm: 120, yMm: 30, widthMm: 45, format: undefined }] })
    expect(codes(buildPrintLayout({ template: kissing, data: data() }))).not.toContain('FIELD_COLLISION')
  })
})

describe('layout engine — amount in words through the port', () => {
  const wordsField = createTemplateField({
    id: 'amount-words',
    key: 'amountWords',
    label: 'Words',
    xMm: 10,
    yMm: 55,
    widthMm: 120,
    heightMm: 7,
    fontSizePt: 9,
    source: 'amountWords',
    format: 'amount-words-en',
    zIndex: 2,
  })

  it('renders the words line through the injected converter and records which one it used', () => {
    const t = template({ fields: [PAYEE, AMOUNT, wordsField] })
    const layout = buildPrintLayout({ template: t, data: data(), options: { amountInWords: wordsConverter() } })
    const run = runOf(layout, 'amount-words')
    expect(run.sourceText).toBe('one thousand five hundred pounds only')
    expect(layout.blocked).toBe(false)
  })

  it('honours the uppercase knob the stock needs', () => {
    const t = template({
      fields: [PAYEE, AMOUNT, createTemplateField({ ...wordsField, textTransform: 'uppercase' })],
    })
    expect(runOf(buildPrintLayout({ template: t, data: data(), options: { amountInWords: wordsConverter() } }), 'amount-words').sourceText).toBe(
      'ONE THOUSAND FIVE HUNDRED POUNDS ONLY'
    )
  })

  it('uses a caller-supplied words line when there is no converter, instead of inventing one', () => {
    const t = template({ fields: [PAYEE, AMOUNT, wordsField] })
    const layout = buildPrintLayout({
      template: t,
      data: data({ amountWords: 'one thousand five hundred pounds only' }),
    })
    expect(runOf(layout, 'amount-words').sourceText).toBe('one thousand five hundred pounds only')
    expect(layout.blocked).toBe(false)
  })

  it('blocks when the words line is empty and there is nothing to render it', () => {
    const t = template({ fields: [PAYEE, AMOUNT, createTemplateField({ ...wordsField, required: true })] })
    const layout = buildPrintLayout({ template: t, data: data() })
    expect(codes(layout)).toContain('REQUIRED_FIELD_EMPTY')
    expect(layout.blocked).toBe(true)
  })

  it('warns when the stored words disagree with the amount, because the words govern', () => {
    const t = template({ fields: [PAYEE, AMOUNT, wordsField] })
    const layout = buildPrintLayout({
      template: t,
      data: data({ amountWords: 'two thousand pounds only' }),
      options: { amountInWords: wordsConverter('one thousand five hundred pounds only') },
    })
    expect(codes(layout)).toContain('AMOUNT_NUMBER_WORDS_MISMATCH')
    expect(layout.warnings.find((warning) => warning.code === 'AMOUNT_NUMBER_WORDS_MISMATCH')?.severity).toBe('warning')
  })
})
