import { describe, expect, it } from 'vitest'
import {
  createBankChequeTemplate,
  createTemplateField,
  validateTemplate,
  assertTemplateValid,
  collectIssues,
  describeTemplateGeometry,
  type BankChequeTemplate,
  type CreateTemplateFieldInput,
  type CreateTemplateInput,
  type PrinterConfigHint,
} from '../index'

const PAYEE: CreateTemplateFieldInput = {
  id: 'payee',
  key: 'payee',
  label: 'Pay to the order of',
  role: 'value',
  xMm: 20,
  yMm: 30,
  widthMm: 100,
  heightMm: 8,
  source: 'payeeName',
  required: true,
}

const AMOUNT: CreateTemplateFieldInput = {
  id: 'amount-numeric',
  key: 'amountNumeric',
  label: 'Amount',
  role: 'value',
  xMm: 130,
  yMm: 40,
  widthMm: 50,
  heightMm: 8,
  source: 'amountDecimal',
  required: true,
}

function draft(overrides: Partial<CreateTemplateInput> = {}): BankChequeTemplate {
  return createBankChequeTemplate({
    id: 'test-cheque',
    bankId: 'bank:test',
    bankName: 'Test Bank',
    name: 'Test cheque',
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
    ...overrides,
  })
}

function codesOf(template: BankChequeTemplate) {
  const report = validateTemplate(template)
  return {
    ok: report.ok,
    errorCodes: report.errors.map((issue) => issue.code),
    warningCodes: report.warnings.map((issue) => issue.code),
  }
}

describe('template validation — the units invariant', () => {
  it('accepts a minimal, millimetre-only template with no notes at all', () => {
    const { ok, errorCodes, warningCodes } = codesOf(draft())
    expect(ok).toBe(true)
    expect(errorCodes).toEqual([])
    expect(warningCodes).toEqual([])
  })

  it('refuses a template whose unit is anything other than millimetres (T1)', () => {
    const tampered = { ...draft(), unit: 'px' as unknown as 'mm' }
    expect(codesOf(tampered).errorCodes).toContain('TEMPLATE_UNIT_MUST_BE_MM')
  })

  it('reports a geometry value that is not a finite number', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, xMm: Number.NaN }],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_GEOMETRY_NOT_FINITE')
  })

  it('warns when a hand-edited millimetre value is finer than the engine will print', () => {
    const template = draft()
    // Bypassing `createTemplateField`, as an imported JSON template would.
    const stored: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, yMm: 30.0006 }, template.fields[1]!],
    }
    expect(codesOf(stored).warningCodes).toContain('FIELD_GEOMETRY_SUB_MICRON')
  })

  it('rounds to the canonical precision when constructing, so hashes are stable', () => {
    const template = draft({ fields: [{ ...PAYEE, xMm: 20 + 1e-13 }, AMOUNT] })
    expect(template.fields[0]?.xMm).toBe(20)
  })
})

describe('template validation — identity and version', () => {
  it('requires the attribution fields a print record depends on', () => {
    const tampered: BankChequeTemplate = { ...draft(), bankName: '   ' }
    expect(codesOf(tampered).errorCodes).toContain('TEMPLATE_IDENTITY_INCOMPLETE')
  })

  it('requires an integer version of at least 1 (T4)', () => {
    const tampered: BankChequeTemplate = { ...draft(), version: 0 }
    expect(codesOf(tampered).errorCodes).toContain('TEMPLATE_VERSION_INVALID')
  })
})

describe('template validation — the sheet', () => {
  it('requires positive, finite paper and body dimensions', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, bodyHeightMm: 0, widthMm: Number.NaN },
    }
    const codes = codesOf(tampered).errorCodes
    expect(codes).toContain('PAPER_GEOMETRY_NOT_FINITE')
    expect(codes).toContain('PAPER_DIMENSION_NON_POSITIVE')
  })

  it('refuses a body that starts before the sheet edge', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, bodyOriginMm: { xMm: -2, yMm: 0 } },
    }
    expect(codesOf(tampered).errorCodes).toContain('BODY_ORIGIN_NEGATIVE')
  })

  it('refuses a body that hangs off the sheet', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, bodyWidthMm: 260 },
    }
    expect(codesOf(tampered).errorCodes).toContain('BODY_OUTSIDE_PAPER')
  })

  it('refuses a sheet that is not physically printable', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, widthMm: 9000, bodyWidthMm: 9000 },
    }
    expect(codesOf(tampered).errorCodes).toContain('PAPER_DIMENSIONS_UNREALISTIC')
  })

  it('warns, without blocking, when the declared orientation disagrees with the measured one', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, orientation: 'portrait' },
    }
    const { errorCodes, warningCodes } = codesOf(tampered)
    expect(errorCodes).not.toContain('PAPER_ORIENTATION_MISMATCH')
    expect(warningCodes).toContain('PAPER_ORIENTATION_MISMATCH')
  })
})

describe('template validation — field geometry', () => {
  it('errors when a printed field is off the sheet, because the printer would drop it silently', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, xMm: 195, widthMm: 20 }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_OUTSIDE_PAPER')
  })

  it('warns when a field leaves the declared body but stays on the sheet (a counterfoil)', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, bodyWidthMm: 100 },
      fields: [template.fields[0]!, { ...template.fields[1]!, xMm: 120 }],
    }
    expect(codesOf(tampered).warningCodes).toContain('FIELD_OUTSIDE_BODY')
  })

  it('measures a field from the body origin, not the sheet origin', () => {
    const template = draft()
    // Same field, but the sheet now carries a 60mm stub above the body: on a sheet-relative
    // engine this would be off the page, on a body-relative one it is still inside the body.
    const shifted: BankChequeTemplate = {
      ...template,
      paper: { ...template.paper, heightMm: 150, bodyOriginMm: { xMm: 0, yMm: 60 }, bodyHeightMm: 78 },
    }
    expect(codesOf(shifted).errorCodes).not.toContain('FIELD_OUTSIDE_PAPER')
  })

  it('rejects a field with no extent', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, widthMm: 0, heightMm: 0 }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_DIMENSION_NON_POSITIVE')
  })

  it('rejects a printed field too small to hold a line of type', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, widthMm: 1.5, heightMm: 1.5 }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_TOO_SMALL')
  })

  it('accepts a small preview-only guide', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, widthMm: 1.5, heightMm: 1.5, isPrinted: false }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).not.toContain('FIELD_TOO_SMALL')
  })

  it('rejects an impossible rotation', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, rotationDeg: 360 }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_ROTATION_INVALID')
  })
})

describe('template validation — field identity and mapping', () => {
  it('rejects a duplicate field id', () => {
    const template = draft({ fields: [PAYEE, createTemplateField({ ...PAYEE, source: 'amountDecimal', key: 'amountNumeric' })] })
    expect(codesOf(template).errorCodes).toContain('FIELD_ID_DUPLICATE')
  })

  it('requires an id and a label', () => {
    const template = draft({
      fields: [
        createTemplateField({ ...PAYEE, id: ' ' }),
        createTemplateField({ ...AMOUNT, id: 'amount-without-label', label: '   ' }),
      ],
    })
    const codes = codesOf(template)
    expect(codes.errorCodes).toContain('FIELD_ID_MISSING')
    expect(codes.warningCodes).toContain('FIELD_LABEL_MISSING')
  })

  it('keeps custom keys lower-case and hyphenated', () => {
    const template = draft({
      fields: [createTemplateField({ ...PAYEE, key: 'Branch_Code', source: 'custom', customKey: 'branchCode' }), AMOUNT],
    })
    expect(codesOf(template).errorCodes).toContain('FIELD_KEY_INVALID')
    const good = draft({
      fields: [createTemplateField({ ...PAYEE, key: 'branch-code', source: 'custom', customKey: 'branchCode' }), AMOUNT],
    })
    expect(codesOf(good).errorCodes).toEqual([])
  })

  it('flags two printed fields bound to the same key and role', () => {
    const template = draft({ fields: [PAYEE, createTemplateField({ ...PAYEE, id: 'payee-2' })] })
    expect(codesOf(template).warningCodes).toContain('FIELD_KEY_ROLE_DUPLICATE')
  })

  it('requires a custom key when the field maps to the custom source', () => {
    const template = draft({
      fields: [createTemplateField({ ...PAYEE, key: 'branch-code', source: 'custom' }), AMOUNT],
    })
    expect(codesOf(template).errorCodes).toContain('FIELD_CUSTOM_SOURCE_MISSING_KEY')
  })

  it('requires a source for a key the engine cannot resolve on its own', () => {
    const template = draft({
      fields: [createTemplateField({ id: 'cnp', key: 'cnp', label: 'CNP', xMm: 10, yMm: 10, widthMm: 40, heightMm: 8 }), AMOUNT],
    })
    expect(codesOf(template).errorCodes).toContain('FIELD_CUSTOM_SOURCE_REQUIRED')
  })

  it('rejects an unknown format', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, format: 'date-RFC2822' as never }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_FORMAT_UNKNOWN')
  })

  it('catches a words format pointed at an unrelated source', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [
        { ...template.fields[0]!, format: 'amount-words-en', source: 'memo' },
        template.fields[1]!,
      ],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_WORDS_SOURCE_MISMATCH')
  })

  it('warns about a required field that is preview-only', () => {
    const template = draft()
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, isPrinted: false }, template.fields[1]!],
    }
    expect(codesOf(tampered).warningCodes).toContain('FIELD_REQUIRED_BUT_NOT_PRINTED')
  })

  it('warns about a hard-LTR payee on an RTL stock', () => {
    const template = draft({ defaultDirection: 'rtl' })
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...template.fields[0]!, typography: { ...template.fields[0]!.typography, direction: 'ltr' } }, template.fields[1]!],
    }
    expect(codesOf(tampered).warningCodes).toContain('FIELD_DIRECTION_SUSPECT')
  })
})

describe('template validation — typography', () => {
  it('requires a font family and a positive point size', () => {
    const template = draft()
    const field = template.fields[0]!
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [
        { ...field, typography: { ...field.typography, fontFamily: ' ', fontSizePt: 0 } },
        template.fields[1]!,
      ],
    }
    const codes = codesOf(tampered).errorCodes
    expect(codes).toContain('FIELD_FONT_MISSING')
    expect(codes).toContain('FIELD_FONT_SIZE_INVALID')
  })

  it('warns about an out-of-range weight or line height without blocking', () => {
    const template = draft()
    const field = template.fields[0]!
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [
        { ...field, typography: { ...field.typography, fontWeight: 40, lineHeight: 5 } },
        template.fields[1]!,
      ],
    }
    const { errorCodes, warningCodes } = codesOf(tampered)
    expect(errorCodes).toEqual([])
    expect(warningCodes).toContain('FIELD_FONT_WEIGHT_INVALID')
    expect(warningCodes).toContain('FIELD_LINE_HEIGHT_UNREALISTIC')
  })

  it('rejects a non-numeric maxChars or a non-integer z-index', () => {
    const template = draft()
    const field = template.fields[0]!
    const tampered: BankChequeTemplate = {
      ...template,
      fields: [{ ...field, maxChars: 0, zIndex: 1.5 }, template.fields[1]!],
    }
    expect(codesOf(tampered).errorCodes).toContain('FIELD_MAX_CHARS_INVALID')
    expect(codesOf(tampered).warningCodes).toContain('FIELD_Z_INDEX_NOT_INTEGER')
  })
})

describe('template validation — the two hard prohibitions', () => {
  it('blocks a printed MICR field (T5)', () => {
    const micr = createTemplateField({
      id: 'micr-band',
      key: 'micr',
      label: 'MICR band',
      xMm: 20,
      yMm: 66,
      widthMm: 160,
      heightMm: 8,
      isMicr: true,
      source: 'chequeNumber',
    })
    const template = draft({ fields: [PAYEE, micr] })
    const codes = codesOf(template)
    expect(codes.errorCodes).toContain('MICR_ENCODING_NOT_IMPLEMENTED')
    // The pre-printed band also makes the field redundant, which is reported, not guessed.
    expect(codes.warningCodes).toContain('FIELD_SUPPRESSED_BY_PREPRINTED')
  })

  it('allows a preview-only MICR alignment guide', () => {
    const micr = createTemplateField({
      id: 'micr-band',
      key: 'micr',
      label: 'MICR band (guide)',
      xMm: 20,
      yMm: 66,
      widthMm: 160,
      heightMm: 8,
      isMicr: true,
      isPrinted: false,
      role: 'guide',
    })
    const template = draft({ fields: [PAYEE, AMOUNT, micr] })
    expect(codesOf(template).errorCodes).not.toContain('MICR_ENCODING_NOT_IMPLEMENTED')
  })

  it('refuses a MICR key that silently omits its data source', () => {
    const micr = createTemplateField({
      id: 'micr-band',
      key: 'micr',
      label: 'MICR band',
      xMm: 20,
      yMm: 66,
      widthMm: 160,
      heightMm: 8,
    })
    const template = draft({ fields: [PAYEE, micr] })
    expect(codesOf(template).errorCodes).toContain('MICR_ENCODING_NOT_IMPLEMENTED')
  })

  it('blocks artwork and security background in the print output (T2)', () => {
    const logo = createTemplateField({
      id: 'logo',
      key: 'bank-info',
      label: 'Bank logo',
      role: 'artwork',
      xMm: 10,
      yMm: 6,
      widthMm: 30,
      heightMm: 12,
      source: 'bankName',
    })
    const background = createTemplateField({
      id: 'guilloche',
      key: 'background',
      label: 'Security background',
      role: 'background',
      xMm: 0,
      yMm: 0,
      widthMm: 190,
      heightMm: 78,
      source: 'custom',
      customKey: 'x',
    })
    const template = draft({ fields: [logo, background] })
    const codes = codesOf(template).errorCodes
    expect(codes).toContain('ARTWORK_NOT_ALLOWED')
  })

  it('allows an artwork guide, because the designer still needs to see the box', () => {
    const logo = createTemplateField({
      id: 'logo',
      key: 'bank-info',
      label: 'Bank logo',
      role: 'artwork',
      xMm: 10,
      yMm: 6,
      widthMm: 30,
      heightMm: 12,
      isPrinted: false,
      source: 'bankName',
    })
    const template = draft({ fields: [PAYEE, AMOUNT, logo] })
    expect(codesOf(template).errorCodes).not.toContain('ARTWORK_NOT_ALLOWED')
  })

  it('requires at least one printed field, and reports an empty draft as a draft', () => {
    const template = draft({ fields: [createTemplateField({ ...PAYEE, isPrinted: false }), AMOUNT] })
    expect(validateTemplate(template).warnings.some((issue) => issue.code === 'NO_PRINTED_FIELDS')).toBe(false)

    const guideOnly = draft({ fields: [createTemplateField({ ...PAYEE, isPrinted: false })] })
    expect(codesOf(guideOnly).warningCodes).toContain('NO_PRINTED_FIELDS')
    expect(
      validateTemplate(guideOnly, { allowEmpty: true }).warnings.some((issue) => issue.code === 'NO_PRINTED_FIELDS')
    ).toBe(false)

    const empty = draft({ fields: [] })
    expect(codesOf(empty).errorCodes).toContain('NO_FIELDS')
  })
})

describe('template validation — the pre-printed suppression table (T3)', () => {
  it('reports a field the stock already prints as a fact, not a surprise', () => {
    const dateCaption = createTemplateField({
      id: 'date-caption',
      key: 'date',
      label: 'Date',
      role: 'caption',
      xMm: 140,
      yMm: 8,
      widthMm: 30,
      heightMm: 6,
    })
    const template = draft({ fields: [PAYEE, AMOUNT, dateCaption] })
    const issue = codesOf(template)
    expect(issue.warningCodes).toContain('FIELD_SUPPRESSED_BY_PREPRINTED')
    expect(issue.errorCodes).toEqual([])
  })

  it('never suppresses the amount value itself', () => {
    const words = createTemplateField({
      id: 'amount-words',
      key: 'amountWords',
      label: 'Words',
      role: 'value',
      xMm: 20,
      yMm: 55,
      widthMm: 150,
      heightMm: 8,
      source: 'amountWords',
      format: 'amount-words-en',
    })
    const template = draft({ fields: [PAYEE, AMOUNT, words] })
    expect(codesOf(template).warningCodes).not.toContain('FIELD_SUPPRESSED_BY_PREPRINTED')
  })

  it('prints a suppressed field once the stock is flagged as blank paper', () => {
    const memoCaption = createTemplateField({
      id: 'memo-caption',
      key: 'memo',
      label: 'Memo',
      role: 'caption',
      xMm: 20,
      yMm: 70,
      widthMm: 40,
      heightMm: 6,
    })
    const template = draft({
      fields: [PAYEE, AMOUNT, memoCaption],
      preprinted: { hasMemoCaption: false },
    })
    expect(codesOf(template).warningCodes).not.toContain('FIELD_SUPPRESSED_BY_PREPRINTED')
  })
})

describe('template validation — the printer axis stays out (T7)', () => {
  const withHint = (hint: PrinterConfigHint) => codesOf({ ...draft(), printerConfigHint: hint }).errorCodes

  it.each(['xOffsetMm', 'yOffsetMm', 'scale', 'scaleX', 'scaleY', 'nominalDpi', 'unprintableMarginMm', 'skewDeg'])(
    'forbids %s on the template',
    (key) => {
      const hint = { [key]: 1 } as unknown as PrinterConfigHint
      expect(withHint(hint)).toContain('PRINTER_HINT_GEOMETRY_FORBIDDEN')
    }
  )

  it('accepts paper-handling hints, which are the template author business', () => {
    expect(withHint({ paperFeed: 'manual', duplex: 'none', colourMode: 'mono' })).not.toContain(
      'PRINTER_HINT_GEOMETRY_FORBIDDEN'
    )
  })

  it('treats an absent hint as valid', () => {
    const template = draft()
    const withoutHint: BankChequeTemplate = { ...template }
    delete (withoutHint as { printerConfigHint?: PrinterConfigHint }).printerConfigHint
    expect(codesOf(withoutHint).errorCodes).toEqual([])
  })
})

describe('validation report plumbing', () => {
  it('assertTemplateValid throws with the errors attached', () => {
    const template = draft({ version: -3, fields: [] })
    try {
      assertTemplateValid(template)
      throw new Error('should have thrown')
    } catch (error) {
      const asError = error as { name?: string; errors?: { code: string }[]; templateName?: string }
      expect(asError.name).toBe('TemplateValidationError')
      expect(asError.errors?.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['NO_FIELDS', 'TEMPLATE_VERSION_INVALID'])
      )
      expect(asError.templateName).toBe('Test cheque')
    }
  })

  it('collects human-readable lines for the designer', () => {
    const report = validateTemplate(draft({ version: 0 }))
    const lines = collectIssues(report)
    expect(lines.some((line) => line.startsWith('ERROR TEMPLATE_VERSION_INVALID'))).toBe(true)
  })

  it('describes the geometry in words, for the diagnostics panel', () => {
    const lines = describeTemplateGeometry(draft())
    expect(lines.join('\n')).toContain('200 x 90 mm')
  })

  it('keeps fields frozen, so a UI edit cannot mutate a published template', () => {
    const template = draft()
    expect(Object.isFrozen(template)).toBe(true)
    expect(Object.isFrozen(template.fields[0])).toBe(true)
    expect(() => {
      ;(template.fields[0] as { xMm: number }).xMm = 0
    }).toThrow(TypeError)
  })
})
