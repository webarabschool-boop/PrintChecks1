import { describe, expect, it } from 'vitest'
import { TemplateValidationError } from '../../errors'
import {
  BUILTIN_TEMPLATES,
  BUILTIN_TEMPLATE_IDS,
  DEFAULT_PREPRINTED,
  TemplateRegistry,
  builtinTemplateById,
  computeTemplateHash,
  createBankChequeTemplate,
  createTemplateField,
  findFieldByKey,
  guideFields,
  nextTemplateVersion,
  printedFields,
  sameLayoutAs,
  validateTemplate,
  withActiveState,
  type BankChequeTemplate,
  type CreateTemplateInput,
} from '../index'

const PAYEE = createTemplateField({
  id: 'payee',
  key: 'payee',
  label: 'Pay to the order of',
  xMm: 20,
  yMm: 30,
  widthMm: 110,
  heightMm: 8,
  source: 'payeeName',
  required: true,
})

const AMOUNT = createTemplateField({
  id: 'amount-numeric',
  key: 'amountNumeric',
  label: 'Amount',
  xMm: 140,
  yMm: 42,
  widthMm: 45,
  heightMm: 8,
  source: 'amountDecimal',
  format: 'amount-2dp',
  alignment: { horizontal: 'right', vertical: 'middle' },
  required: true,
})

function draft(overrides: Partial<CreateTemplateInput> = {}): BankChequeTemplate {
  return createBankChequeTemplate({
    id: 'acme-cheque',
    bankId: 'bank:acme',
    bankName: 'Acme Bank',
    name: 'Acme personal cheque',
    stockType: 'personal',
    paper: {
      widthMm: 190,
      heightMm: 80,
      orientation: 'landscape',
      bodyOriginMm: { xMm: 0, yMm: 0 },
      bodyWidthMm: 190,
      bodyHeightMm: 80,
    },
    fields: [PAYEE, AMOUNT],
    ...overrides,
  })
}

describe('template hashing', () => {
  it('ignores timestamps and lifecycle, so saving twice is not a content change', () => {
    const a = draft()
    const b = createBankChequeTemplate({
      ...draftOverridesWith(a),
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    })
    expect(computeTemplateHash(b)).toBe(a.templateHash)
    const deactivated = withActiveState(a, false, '2020-01-01T00:00:00.000Z')
    expect(computeTemplateHash(deactivated)).toBe(a.templateHash)
    expect(sameLayoutAs(a, deactivated)).toBe(true)
  })

  it('changes when a single millimetre moves', () => {
    const a = draft()
    const b = createBankChequeTemplate({
      ...draftOverridesWith(a),
      fields: [{ ...PAYEE, xMm: PAYEE.xMm + 1 }, AMOUNT],
    })
    expect(computeTemplateHash(b)).not.toBe(a.templateHash)
  })

  it('is stable across a JSON round trip, which is what the reprint pin relies on', () => {
    const template = draft()
    const reparsed = JSON.parse(JSON.stringify(template)) as BankChequeTemplate
    expect(computeTemplateHash(reparsed)).toBe(template.templateHash)
  })

  it('is stored on the template at construction time', () => {
    const template = draft()
    expect(template.templateHash).toBe(computeTemplateHash({ ...template, templateHash: 'garbage' }))
  })
})

/** `createBankChequeTemplate` accepts template-shaped input, so spread a built one back in. */
function draftOverridesWith(template: BankChequeTemplate): CreateTemplateInput {
  return {
    id: template.id,
    version: template.version,
    bankId: template.bankId,
    bankName: template.bankName,
    name: template.name,
    stockType: template.stockType,
    stockReference: template.stockReference,
    description: template.description,
    paper: template.paper,
    origin: template.origin,
    fields: template.fields,
    preprinted: template.preprinted,
    defaultDirection: template.defaultDirection,
    defaultLocale: template.defaultLocale,
    printerConfigHint: template.printerConfigHint,
    isActive: template.isActive,
  }
}

describe('nextTemplateVersion — publishing, not editing', () => {
  it('derives a new version and keeps the identity and creation date', () => {
    const previous = draft({ version: 4 })
    const next = nextTemplateVersion(previous, { fields: [{ ...PAYEE, widthMm: 100 }, AMOUNT] })
    expect(next.version).toBe(5)
    expect(next.id).toBe(previous.id)
    expect(next.createdAt).toBe(previous.createdAt)
    expect(next.isActive).toBe(true)
    expect(validateTemplate(next).ok).toBe(true)
  })

  it('recomputes the hash, so two versions never share one', () => {
    const previous = draft()
    const next = nextTemplateVersion(previous, { name: 'Renamed only' })
    expect(next.name).toBe('Renamed only')
    expect(next.templateHash).not.toBe(previous.templateHash)
  })

  it('refuses to publish a version that changes nothing', () => {
    const previous = draft()
    expect(() => nextTemplateVersion(previous, { name: previous.name })).toThrow(/no content change/)
  })

  it('merges preprinted flags instead of replacing them', () => {
    const next = nextTemplateVersion(draft(), { preprinted: { hasMicrBand: false } })
    expect(next.preprinted.hasMicrBand).toBe(false)
    expect(next.preprinted.hasPayeeCaption).toBe(DEFAULT_PREPRINTED.hasPayeeCaption)
  })

  it('returns a frozen value, so a caller cannot edit a published layout in place', () => {
    const next = nextTemplateVersion(draft(), { description: 'tightened' })
    expect(Object.isFrozen(next)).toBe(true)
    expect(Object.isFrozen(next.fields)).toBe(true)
  })
})

describe('TemplateRegistry', () => {
  it('publishes a valid template and keeps versions side by side', () => {
    const registry = new TemplateRegistry()
    const v1 = draft()
    const v2 = createBankChequeTemplate({ ...draftOverridesWith(v1), version: 2, name: 'Acme personal cheque (v2)' })
    expect(registry.publish(v1).createdVersion).toBe(1)
    expect(registry.publish(v2).createdVersion).toBe(2)
    expect(registry.size).toBe(2)
    expect(registry.listVersions('acme-cheque')).toEqual([1, 2])
    expect(registry.latest('acme-cheque')?.version).toBe(2)
    expect(registry.get('acme-cheque', 1)?.version).toBe(1)
    expect(registry.all().map((template) => template.version)).toEqual([1, 2])
  })

  it('refuses to publish an invalid template (T4, T5, T7 are enforced at the gate)', () => {
    const registry = new TemplateRegistry()
    const broken = createBankChequeTemplate({
      ...draftOverridesWith(draft()),
      id: 'broken',
      fields: [],
    })
    let caught: unknown
    try {
      registry.publish(broken)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TemplateValidationError)
    expect((caught as TemplateValidationError).errors.map((issue) => issue.code)).toContain('NO_FIELDS')
    expect(registry.size).toBe(0)
  })

  it('allows an explicit draft registry for the designer', () => {
    const drafting = new TemplateRegistry({ validateOnPublish: false })
    expect(drafting.publish(createBankChequeTemplate({ ...draftOverridesWith(draft()), fields: [] })).template.fields).toEqual([])
  })

  it('treats re-publishing identical content as a no-op, and refuses a changed version number', () => {
    const registry = new TemplateRegistry()
    const template = draft()
    registry.publish(template)
    expect(registry.publish(template).alreadyPublished).toBe(true)
    const changed = createBankChequeTemplate({ ...draftOverridesWith(template), name: 'edited after release' })
    expect(() => registry.publish(changed)).toThrow(/already published with different content/)
    expect(() => registry.publish(changed)).toThrow(/Publish version 2 instead/)
  })

  it('refuses a template carrying a stale hash, i.e. one that was hand-edited', () => {
    const registry = new TemplateRegistry()
    const tampered: BankChequeTemplate = { ...draft(), templateHash: 'deadbeef' }
    expect(() => registry.publish(tampered)).toThrow(/stale templateHash/)
  })

  it('resolves the exact version a job pinned and never silently falls back to the latest', () => {
    const registry = new TemplateRegistry()
    const v1 = draft()
    registry.publish(v1)
    registry.publish(createBankChequeTemplate({ ...draftOverridesWith(v1), version: 2, name: 'second' }))
    expect(registry.resolvePinned('acme-cheque', 1).version).toBe(1)
    expect(() => registry.resolvePinned('acme-cheque', 7)).toThrow(/has no version 7/)
    expect(() => registry.resolvePinned('acme-cheque', 7)).toThrow(/published: v1, v2/)
    expect(() => registry.resolvePinned('missing', 1)).toThrow(/is not published/)
    // A freshly installed registry has nothing to list, and says so instead of printing "()".
    expect(() => new TemplateRegistry().resolvePinned('missing', 1)).toThrow(/known ids: none/)
  })

  it('activates and deactivates versions without touching the layout hash', () => {
    const registry = new TemplateRegistry()
    const template = draft()
    registry.publish(template)
    const deactivated = registry.setActive('acme-cheque', 1, false, '2026-01-02T00:00:00.000Z')
    expect(deactivated.isActive).toBe(false)
    expect(deactivated.templateHash).toBe(template.templateHash)
    expect(registry.findActive()).toEqual([])
    expect(registry.findActive('bank:acme')).toEqual([])
    expect(registry.findByBank('bank:acme').map((entry) => entry.version)).toEqual([1])
    registry.setActive('acme-cheque', 1, true)
    expect(registry.findActive('bank:acme').map((entry) => entry.version)).toEqual([1])
  })

  it('refuses to delete a version a print record still references', () => {
    const referenced = new TemplateRegistry({ isVersionReferenced: (id, version) => id === 'acme-cheque' && version === 1 })
    referenced.publish(draft())
    expect(() => referenced.remove('acme-cheque', 1)).toThrow(/referenced by a print record/)
    expect(() => referenced.remove('acme-cheque', 1)).toThrow(/deactivate it instead/)
    expect(referenced.size).toBe(1)

    const free = new TemplateRegistry()
    free.publish(draft())
    expect(free.remove('acme-cheque', 1)).toBe(true)
    expect(free.remove('acme-cheque', 1)).toBe(false)
    expect(free.size).toBe(0)
  })

  it('finds the stock the customer actually has in the drawer', () => {
    const registry = new TemplateRegistry()
    const leaflet = createBankChequeTemplate({
      ...draftOverridesWith(draft()),
      stockReference: 'ACME-LEAFLET-PERSONAL-3PART',
    })
    registry.publish(leaflet)
    expect(registry.findByStockReference('bank:acme', 'ACME-LEAFLET-PERSONAL-3PART')?.stockReference).toBe(
      'ACME-LEAFLET-PERSONAL-3PART'
    )
    expect(registry.findByStockReference('bank:other', 'ACME-LEAFLET-PERSONAL-3PART')).toBeNull()
    expect(registry.findByStockReference('bank:acme', '')).toBeNull()
    // An inactive version is not a stock a customer can be handed.
    registry.setActive('acme-cheque', 1, false)
    expect(registry.findByStockReference('bank:acme', 'ACME-LEAFLET-PERSONAL-3PART')).toBeNull()
  })

  it('reports per-template failures when loading saved templates, instead of failing at boot', () => {
    const registry = new TemplateRegistry()
    const broken = createBankChequeTemplate({ ...draftOverridesWith(draft()), id: 'corrupt', fields: [] })
    const result = registry.publishAll([draft(), broken])
    expect(result.published.map((template) => template.id)).toEqual(['acme-cheque'])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.templateId).toBe('corrupt')
    expect(result.failures[0]?.issues.map((issue) => issue.code)).toContain('NO_FIELDS')
  })

  it('hands out frozen templates, so a UI cannot edit registry contents in place', () => {
    const registry = new TemplateRegistry()
    registry.publish(draft())
    const fetched = registry.get('acme-cheque')
    expect(fetched).not.toBeNull()
    expect(Object.isFrozen(fetched)).toBe(true)
  })
})

describe('template field helpers', () => {
  it('separates what prints from what is only drawn for the designer', () => {
    const template = createBankChequeTemplate({
      ...draftOverridesWith(draft()),
      fields: [
        PAYEE,
        AMOUNT,
        createTemplateField({
          id: 'micr-guide',
          key: 'micr',
          label: 'MICR band (pre-printed)',
          role: 'guide',
          xMm: 10,
          yMm: 66,
          widthMm: 170,
          heightMm: 9,
          isPrinted: false,
        }),
      ],
    })
    expect(printedFields(template).map((field) => field.id)).toEqual(['payee', 'amount-numeric'])
    expect(guideFields(template).map((field) => field.id)).toEqual(['micr-guide'])
    expect(findFieldByKey(template, 'payee')?.id).toBe('payee')
    expect(findFieldByKey(template, 'payee', 'caption')).toBeNull()
  })
})

describe('built-in bank templates', () => {
  it.each(BUILTIN_TEMPLATES.map((template) => [template.id, template] as const))('%s validates with no errors', (_id, template) => {
    const report = validateTemplate(template)
    expect(report.errors.map((issue) => `${issue.code} ${issue.message}`)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('uses millimetres everywhere and never a pixel', () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(template.unit).toBe('mm')
      expect(template.origin).toBe('top-left')
      expect(Number.isInteger(template.paper.widthMm * 10)).toBe(true)
      for (const field of template.fields) {
        expect(Object.keys(field)).not.toContain('xPx')
        expect(field.typography.fontFamily.length).toBeGreaterThan(0)
      }
    }
  })

  it('never prints the bank artwork or the security background (T2)', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const printed = printedFields(template)
      expect(printed.some((field) => field.role === 'artwork' || field.role === 'background')).toBe(false)
      expect(printed.some((field) => field.typography.isMicr)).toBe(false)
    }
  })

  it('describes the MICR band as a preview-only guide, and does not encode it (T5)', () => {
    const micrFields = BUILTIN_TEMPLATES.flatMap((template) =>
      template.fields.filter((field) => field.key === 'micr' || field.typography.isMicr)
    )
    expect(micrFields.length).toBeGreaterThan(0)
    expect(micrFields.every((field) => field.isPrinted === false)).toBe(true)
    expect(micrFields.every((field) => field.role === 'guide')).toBe(true)
    // And the package as a whole contains no magnetic-ink encoder.
    expect(BUILTIN_TEMPLATE_IDS.length).toBe(4)
  })

  it('suppresses the pre-printed captions rather than printing over them (T3)', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const printedKeys = new Set(printedFields(template).map((field) => `${field.key}:${field.role}`))
      expect(printedKeys.has('payee:caption')).toBe(false)
      expect(printedKeys.has('date:caption')).toBe(false)
      expect(printedKeys.has('memo:caption')).toBe(false)
      expect(printedKeys.has('amountNumeric:box')).toBe(false)
      expect(printedKeys.has('micr:value')).toBe(false)
      // The values themselves are ours to print, even on a fully pre-printed stock.
      expect(printedKeys.has('payee:value')).toBe(true)
      expect(printedKeys.has('amountNumeric:value')).toBe(true)
    }
  })

  it('carries an Arabic stock with rtl default and LTR-forced number fields', () => {
    const arabic = builtinTemplateById('nbe-personal-ar-2024')
    expect(arabic?.defaultDirection).toBe('rtl')
    expect(arabic?.defaultLocale).toBe('ar-EG')
    const payee = findFieldByKey(arabic!, 'payee')
    expect(payee?.typography.direction).toBe('auto')
    const number = findFieldByKey(arabic!, 'chequeNumber')
    expect(number?.typography.direction).toBe('ltr')
  })

  it('offsets the A4 three-part voucher body to the printed cheque, leaving the stubs alone', () => {
    const voucher = builtinTemplateById('nbe-voucher-a4-3part')
    expect(voucher?.paper.widthMm).toBe(210)
    expect(voucher?.paper.heightMm).toBe(297)
    expect(voucher?.paper.orientation).toBe('portrait')
    expect(voucher?.paper.bodyOriginMm).toEqual({ xMm: 0, yMm: 106 })
    expect(voucher?.paper.bodyWidthMm).toBe(210)
    const payee = findFieldByKey(voucher!, 'payee')
    // The field is measured from the body, so its own yMm stays small while it lands at 139.5mm.
    expect(payee!.yMm).toBeLessThan(90)
  })

  it('gives each bank its own templates and each stock its own reference', () => {
    const byBank = new Map<string, string[]>()
    for (const template of BUILTIN_TEMPLATES) {
      byBank.set(template.bankId, [...(byBank.get(template.bankId) ?? []), template.id])
    }
    expect(byBank.get('bank:nbe')?.length).toBe(3)
    expect(byBank.get('bank:cib')).toEqual(['cib-corporate-en-2023'])
    const refs = BUILTIN_TEMPLATES.map((template) => template.stockReference)
    expect(new Set(refs).size).toBe(refs.length)
    expect(refs).toContain('CIB-CORP-EN-190')
  })

  it('ships every built-in in a registry, which is how the app seeds itself', () => {
    const registry = new TemplateRegistry()
    const result = registry.publishAll(BUILTIN_TEMPLATES)
    expect(result.failures).toEqual([])
    expect(result.published.map((template) => template.id)).toEqual(BUILTIN_TEMPLATE_IDS)
    expect(registry.findActive('bank:nbe').length).toBe(3)
    expect(registry.findByStockReference('bank:nbe', 'NBE-VCHR-A4-3')?.id).toBe('nbe-voucher-a4-3part')
  })
})
