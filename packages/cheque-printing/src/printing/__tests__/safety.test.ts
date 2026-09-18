import { describe, expect, it } from 'vitest'
import { PrintBlockedError } from '../../errors'
import { createChequePrintData } from '../../printdata'
import { createPrinterCalibration } from '../../printer/calibration'
import { createPrinterProfile } from '../../printer/profile'
import { createBankChequeTemplate, nextTemplateVersion, withActiveState, type BankChequeTemplate } from '../../template'
import {
  DEFAULT_PRINT_POLICY,
  assertSafetyCleared,
  assessPrintSafety,
  createConfirmation,
  type SafetyContext,
  type SafetyReport,
} from '../safety'
import { fixtureCalibration, fixtureData, fixtureLayout, fixtureProfile, fixtureTemplate, FIXED_AT } from './fixture'

const LATER = '2026-09-18T10:00:00.000Z'

/** The stock this suite pretends is un-numbered, so the number warning never drowns the signal. */
function stock(overrides: Partial<Parameters<typeof createBankChequeTemplate>[0]> = {}): BankChequeTemplate {
  const base = fixtureTemplate()
  return createBankChequeTemplate({
    ...base,
    ...overrides,
    fields:
      overrides.fields ?? [
        ...base.fields,
        { id: 'cheque-number', key: 'chequeNumber', label: 'Number', xMm: 176, yMm: 8, widthMm: 28, heightMm: 6, fontSizePt: 8, source: 'chequeNumber' },
      ],
  })
}

function context(overrides: Partial<SafetyContext> = {}): SafetyContext {
  const template = overrides.template ?? stock()
  return {
    template,
    layout: fixtureLayout({ template }),
    data: fixtureData(),
    profile: fixtureProfile(),
    calibration: fixtureCalibration(),
    now: LATER,
    ...overrides,
  }
}

const codes = (report: SafetyReport) => report.issues.map((issue) => issue.code)
const errorCodes = (report: SafetyReport) => report.errors.map((issue) => issue.code)

describe('the safety gate is on by default', () => {
  it('declares what the default policy refuses to tolerate', () => {
    expect(DEFAULT_PRINT_POLICY).toEqual({
      requireCalibration: true,
      blockOnWarnings: false,
      allowInactiveTemplate: false,
      calibrationStaleAfterDays: 90,
      highAmountDecimal: null,
      pinTemplateHash: true,
    })
  })

  it('passes a prepared, calibrated job — with the MICR band still declared as a warning, not an encoder', () => {
    const report = assessPrintSafety(context({ profile: fixtureProfile({ micrTonerCapable: true }) }))
    expect(report.errors).toEqual([])
    expect(report.blocked).toBe(false)
    expect(report.acknowledgementsRequired).toEqual(['MICR_TONER_DECLARED'])
    expect(report.requiresConfirmation).toBe(true)
    expect(report.summary).toContain('Office LaserJet')
    expect(report.summary).toContain('0 blocking, 1 to acknowledge')
  })

  it('says so when a stock has a MICR band and the printer cannot print it', () => {
    const report = assessPrintSafety(context())
    expect(codes(report)).toContain('MICR_TONER_UNAVAILABLE')
    expect(report.errors).toEqual([])
    const issue = report.warnings.find((entry) => entry.code === 'MICR_TONER_UNAVAILABLE')
    expect(issue?.remediation).toContain('not something this phase produces')
  })

  it('says nothing about MICR for a stock without a band', () => {
    const template = stock({
      fields: [
        { id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 100, heightMm: 8, source: 'payeeName' },
        { id: 'cheque-number', key: 'chequeNumber', label: 'Number', xMm: 176, yMm: 8, widthMm: 28, heightMm: 6, source: 'chequeNumber' },
      ],
      preprinted: { ...fixtureTemplate().preprinted, hasMicrBand: false },
    })
    const report = assessPrintSafety(context({ template }))
    expect(codes(report).join()).not.toContain('MICR')
    expect(report.requiresConfirmation).toBe(false)
  })
})

describe('calibration is required, and is per printer and per stock', () => {
  it('blocks an uncalibrated printer unless the operator opts out explicitly', () => {
    const blocked = assessPrintSafety(context({ calibration: null }))
    expect(errorCodes(blocked)).toContain('CALIBRATION_MISSING')
    expect(blocked.summary).toContain('uncalibrated')

    const allowed = assessPrintSafety(context({ calibration: null, policy: { requireCalibration: false } }))
    expect(allowed.blocked).toBe(false)
    expect(codes(allowed)).toContain('CALIBRATION_MISSING')
    expect(allowed.acknowledgementsRequired).toContain('CALIBRATION_MISSING')
  })

  it('refuses a calibration measured on a different stock', () => {
    const report = assessPrintSafety(context({ calibration: fixtureCalibration({ templateId: 'some-other-cheque' }) }))
    expect(errorCodes(report)).toContain('CALIBRATION_WRONG_STOCK')
    expect(report.errors[0]?.message).toContain('measured for "some-other-cheque"')
  })

  it('refuses a calibration measured against an old version of the same stock', () => {
    const template = withActiveState(fixtureTemplate(), true, FIXED_AT)
    const bumped = nextTemplateVersion(template, { name: 'Wider payee box' })
    // The layout was staged against v1 and the registry has moved to v2.
    const report = assessPrintSafety({
      template: bumped,
      layout: fixtureLayout({ template }),
      data: fixtureData(),
      profile: fixtureProfile(),
      calibration: fixtureCalibration({ templateVersion: 1 }),
      now: LATER,
    })
    expect(errorCodes(report)).toContain('CALIBRATION_VERSION_MISMATCH')
    expect(errorCodes(report)).toContain('TEMPLATE_VERSION_STALE')
  })

  it('warns about a draft calibration and about one that has simply aged out', () => {
    expect(codes(assessPrintSafety(context({ calibration: fixtureCalibration({ confidence: 'draft' }) })))).toContain('CALIBRATION_DRAFT')

    const stale = assessPrintSafety(
      context({ calibration: fixtureCalibration({ measuredAt: '2020-01-01T00:00:00.000Z' }) })
    )
    expect(codes(stale)).toContain('CALIBRATION_STALE')
    expect(stale.warnings.find((issue) => issue.code === 'CALIBRATION_STALE')?.message).toContain('days old')

    const neverExpires = assessPrintSafety(
      context({ calibration: fixtureCalibration({ measuredAt: '2020-01-01T00:00:00.000Z' }), policy: { calibrationStaleAfterDays: null } })
    )
    expect(codes(neverExpires)).not.toContain('CALIBRATION_STALE')
  })

  it('carries a calibration out-of-range error through from the calibration validator', () => {
    const wild = createPrinterCalibration(
      {
        id: 'cal-wild',
        printerProfileId: 'hp-m402',
        templateId: 'nbe-personal-en-2024',
        templateVersion: 1,
        offsetXMm: 12,
        offsetYMm: 0,
        method: 'test-page',
        confidence: 'verified',
      },
      FIXED_AT
    )
    expect(errorCodes(assessPrintSafety(context({ calibration: wild })))).toContain('CALIBRATION_OFFSET_EXCEEDS_LIMIT')
  })
})

describe('the template the layout came from must still be the live one', () => {
  it('blocks printing a deactivated stock', () => {
    const report = assessPrintSafety(context({ template: withActiveState(fixtureTemplate(), false, FIXED_AT) }))
    expect(errorCodes(report)).toContain('TEMPLATE_INACTIVE')

    const deliberate = assessPrintSafety(
      context({ template: withActiveState(fixtureTemplate(), false, FIXED_AT), policy: { allowInactiveTemplate: true } })
    )
    expect(codes(deliberate)).not.toContain('TEMPLATE_INACTIVE')
  })

  it('blocks a layout built before the template moved on (T4 pinning)', () => {
    const template: BankChequeTemplate = fixtureTemplate()
    const edited = createBankChequeTemplate({
      ...template,
      id: 'nbe-personal-en-2024',
      fields: [...template.fields].map((field) => (field.id === 'payee' ? { ...field, widthMm: 100 } : field)),
    })
    const report = assessPrintSafety({
      template: edited,
      layout: fixtureLayout({ template }),
      data: fixtureData(),
      profile: fixtureProfile(),
      calibration: fixtureCalibration(),
      now: LATER,
    })
    expect(errorCodes(report)).toContain('TEMPLATE_CHANGED_SINCE_LAYOUT')
    expect(report.errors[0]?.message).toContain('never previewed')
  })

  it('can be told not to pin the hash, which is how a draft-mode designer stays usable', () => {
    const template = fixtureTemplate()
    const edited = createBankChequeTemplate({ ...template, description: 'note only' })
    const report = assessPrintSafety({
      template: edited,
      layout: fixtureLayout({ template }),
      data: fixtureData(),
      profile: fixtureProfile(),
      calibration: fixtureCalibration(),
      now: LATER,
      policy: { pinTemplateHash: false },
    })
    expect(codes(report)).not.toContain('TEMPLATE_CHANGED_SINCE_LAYOUT')
  })
})

describe('what the printer will physically do to the sheet', () => {
  it('blocks a run that lands in the unprintable margin', () => {
    // A 34mm gripper band swallows the top of the payee box, which starts at 30mm.
    const tight = fixtureProfile({ unprintableMarginMm: { topMm: 34, rightMm: 4, bottomMm: 4, leftMm: 4 } })
    const report = assessPrintSafety(context({ profile: tight }))
    const issues = report.errors.filter((entry) => entry.code === 'RUN_IN_UNPRINTABLE_MARGIN')
    expect(issues.map((entry) => entry.fieldId)).toEqual(expect.arrayContaining(['payee', 'cheque-number']))
    expect(issues[0]?.message).toContain('unprintable margin')
  })

  it('blocks a run the device offsets push off the paper', () => {
    const shifted = fixtureProfile({ xOffsetMm: 24 })
    const report = assessPrintSafety(context({ profile: shifted }))
    expect(errorCodes(report)).toContain('RUN_OFF_PAPER_AFTER_TRANSFORM')
    const issue = report.errors.find((entry) => entry.code === 'RUN_OFF_PAPER_AFTER_TRANSFORM')
    expect(issue?.remediation).toContain('reduce the profile offsets')
  })

  it('blocks a scale so extreme it collapses a run, and warns about a non-square dot grid', () => {
    const collapsed = fixtureProfile({ scale: { x: 0, y: 0 } })
    const report = assessPrintSafety(context({ profile: collapsed }))
    expect(errorCodes(report)).toContain('RUN_COLLAPSED_AFTER_TRANSFORM')
    expect(errorCodes(report)).toContain('PROFILE_SCALE_UNREALISTIC')

    const anisotropic = fixtureProfile({ nominalDpi: { x: 600, y: 550 } })
    const warn = assessPrintSafety(context({ profile: anisotropic }))
    expect(codes(warn)).toContain('PROFILE_DPI_MISMATCH')
    expect(warn.errors.map((issue) => issue.code)).not.toContain('PROFILE_DPI_MISMATCH')

    const hopeless = fixtureProfile({ nominalDpi: { x: 600, y: 300 } })
    expect(errorCodes(assessPrintSafety(context({ profile: hopeless })))).toContain('PROFILE_DPI_MISMATCH')
  })

  it('blocks two runs that only collide because of the transform', () => {
    // Two boxes that miss each other on the sheet: the memo sits below and to the right. A skewed
    // sheet (a bad calibration, or a printer with a worn feed) tilts them into the same band.
    const template = createBankChequeTemplate({
      ...stock(),
      fields: [
        { id: 'a', key: 'payee', label: 'Payee', xMm: 10, yMm: 30, widthMm: 60, heightMm: 8, source: 'payeeName' },
        { id: 'b', key: 'memo', label: 'Memo', xMm: 50, yMm: 44, widthMm: 60, heightMm: 8, source: 'memo' },
      ],
    })
    const layout = fixtureLayout({ template, data: fixtureData({ memo: 'rent for the branch' }) })
    expect(layout.blocked).toBe(false)
    expect(layout.warnings.map((warning) => warning.code)).not.toContain('FIELD_COLLISION')

    const skewed = fixtureCalibration({ skewDeg: 10 })
    const report = assessPrintSafety(context({ template, layout, calibration: skewed }))
    expect(errorCodes(report)).toContain('RUN_COLLISION_AFTER_TRANSFORM')
    // The skew is also out of range on its own account: nothing here is quietly accepted.
    expect(errorCodes(report)).toContain('CALIBRATION_SKEW_EXCEEDS_LIMIT')
  })

  it('leaves a sane profile with nothing to complain about', () => {
    const report = assessPrintSafety(context({ profile: fixtureProfile({ micrTonerCapable: true }) }))
    expect(report.errors).toEqual([])
  })
})

describe('the money itself', () => {
  it('refuses to print a cheque with no amount', () => {
    const data = createChequePrintData(
      { chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '', currency: 'EGP' },
      { lenient: true }
    )
    const report = assessPrintSafety(context({ data }))
    expect(errorCodes(report)).toContain('AMOUNT_MISSING')
  })

  it('asks twice about a zero-amount instrument, because it is legal but unusual', () => {
    const data = createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '0.00', currency: 'EGP' })
    const report = assessPrintSafety(context({ data }))
    expect(codes(report)).toContain('AMOUNT_ZERO')
    expect(report.blocked).toBe(false)
  })

  it('blocks nothing for a large amount, but demands an acknowledgement over the configured limit', () => {
    const data = createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '250000.00', currency: 'EGP' })
    const unconfigured = assessPrintSafety(context({ data }))
    expect(codes(unconfigured)).not.toContain('HIGH_AMOUNT')

    const configured = assessPrintSafety(context({ data, policy: { highAmountDecimal: '100000.00' } }))
    expect(codes(configured)).toContain('HIGH_AMOUNT')
    expect(configured.acknowledgementsRequired).toContain('HIGH_AMOUNT')

    const under = assessPrintSafety({
      ...context({ data: createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '999.99', currency: 'EGP' }), policy: { highAmountDecimal: '1000.00' } }),
    })
    expect(codes(under)).not.toContain('HIGH_AMOUNT')
  })

  it('compares decimal strings without a float, so 1000000.00 is not mistaken for 100000.00', () => {
    const big = createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '1000000.00', currency: 'EGP' })
    expect(codes(assessPrintSafety(context({ data: big, policy: { highAmountDecimal: '999999.99' } })))).toContain('HIGH_AMOUNT')
    const equal = createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '999999.99', currency: 'EGP' })
    expect(codes(assessPrintSafety(context({ data: equal, policy: { highAmountDecimal: '999999.99' } })))).not.toContain('HIGH_AMOUNT')
    const leadingZero = createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '0001500.00', currency: 'EGP' })
    expect(codes(assessPrintSafety(context({ data: leadingZero, policy: { highAmountDecimal: '1000.00' } })))).toContain('HIGH_AMOUNT')
    expect(codes(assessPrintSafety(context({ data: leadingZero, policy: { highAmountDecimal: '2000.00' } })))).not.toContain('HIGH_AMOUNT')
  })
})

describe('layout warnings reach the operator', () => {
  it('turns a blocking layout into a blocked print', () => {
    const template = fixtureTemplate()
    const brokenLayout = fixtureLayout({
      template,
      data: createChequePrintData({ chequeNumber: '1', date: '2026-09-18', payeeName: 'Acme', amountDecimal: '1500.00', currency: 'EGP' }),
    })
    const withNoPayee = fixtureLayout({
      template,
      data: createChequePrintData(
        { chequeNumber: '1', date: '2026-09-18', payeeName: '', amountDecimal: '1500.00', currency: 'EGP' },
        { lenient: true }
      ),
    })
    expect(brokenLayout.blocked).toBe(false)
    const report = assessPrintSafety(context({ template, layout: withNoPayee }))
    expect(errorCodes(report)).toContain('REQUIRED_FIELD_EMPTY')
    expect(report.blocked).toBe(true)
  })

  it('blocks on warnings too when the policy is set that way', () => {
    const report = assessPrintSafety(context({ policy: { blockOnWarnings: true } }))
    expect(report.blocked).toBe(true)
    expect(report.acknowledgementsRequired).toEqual([])
    expect(codes(report)).toContain('MICR_TONER_UNAVAILABLE')
  })
})

describe('duplicate and reprinted cheques', () => {
  it('flags a second send of the same cheque number as a duplicate until it is called a reprint', () => {
    const report = assessPrintSafety(context({ priorAttempts: 1, profile: fixtureProfile({ micrTonerCapable: true }) }))
    expect(codes(report)).toContain('DUPLICATE_PRINT_SUSPECTED')
    expect(report.acknowledgementsRequired).toEqual(
      expect.arrayContaining(['DUPLICATE_PRINT_SUSPECTED'])
    )

    const declared = assessPrintSafety(context({ priorAttempts: 1, isReprint: true, profile: fixtureProfile({ micrTonerCapable: true }) }))
    expect(codes(declared)).not.toContain('DUPLICATE_PRINT_SUSPECTED')
    expect(codes(declared)).toContain('REPRINT')
    expect(declared.warnings.find((issue) => issue.code === 'REPRINT')?.remediation).toContain('destroyed')
  })
})

describe('the confirmation is bound to the report it acknowledges', () => {
  const report = assessPrintSafety(context())

  it('keeps the print locked while nothing has been acknowledged', () => {
    expect(() => assertSafetyCleared(report, null)).toThrow(PrintBlockedError)
    expect(() => assertSafetyCleared(report, null)).toThrow(/explicit acknowledgement of:.*MICR_TONER_UNAVAILABLE/)
    expect(() => assertSafetyCleared(report, createConfirmation(report, 'teller-1', []))).toThrow(/unacknowledged safety warnings/)
  })

  it('accepts a confirmation that names the actor and the codes', () => {
    const confirmation = createConfirmation(report, 'teller-1')
    expect(() => assertSafetyCleared(report, confirmation)).not.toThrow()
    expect(confirmation.acknowledged).toEqual(['MICR_TONER_UNAVAILABLE'])
    expect(confirmation.nonce).toBe(report.nonce)
    expect(Object.isFrozen(confirmation)).toBe(true)
  })

  it('needs no confirmation at all for a clean job', () => {
    const templateWithoutMicr = stock({
      fields: [
        { id: 'payee', key: 'payee', label: 'Payee', xMm: 12, yMm: 30, widthMm: 118, heightMm: 8, source: 'payeeName' },
        { id: 'cheque-number', key: 'chequeNumber', label: 'Number', xMm: 176, yMm: 8, widthMm: 28, heightMm: 6, source: 'chequeNumber' },
      ],
      preprinted: { ...fixtureTemplate().preprinted, hasMicrBand: false },
    })
    const reallyClean = assessPrintSafety(context({ template: templateWithoutMicr, layout: fixtureLayout({ template: templateWithoutMicr }) }))
    expect(reallyClean.requiresConfirmation).toBe(false)
    expect(reallyClean.issues).toEqual([])
    expect(() => assertSafetyCleared(reallyClean, null)).not.toThrow()

    const clean = assessPrintSafety(context({ profile: createPrinterProfile({ id: 'p', name: 'P', supportsCustomPageSize: true, micrTonerCapable: true }, FIXED_AT) }))
    expect(clean.requiresConfirmation).toBe(true)
    expect(clean.acknowledgementsRequired).toEqual(['MICR_TONER_DECLARED'])
  })

  it('rejects a confirmation for a different report — the safety picture changed under the operator', () => {
    const other = assessPrintSafety(context({ policy: { highAmountDecimal: '1.00' } }))
    const stale = createConfirmation(report, 'teller-1')
    expect(() => assertSafetyCleared(other, stale)).toThrow(/report changed after the operator read it/)
  })

  it('rejects an anonymous confirmation', () => {
    const anonymous = Object.freeze({ ...createConfirmation(report, 'teller-1'), actorId: '  ' })
    expect(() => assertSafetyCleared(report, anonymous)).toThrow(/must name who gave it/)
  })

  it('always blocks a job with errors, confirmation or not', () => {
    const blocked = assessPrintSafety(context({ calibration: null }))
    const confirmation = createConfirmation(blocked, 'teller-1', [])
    expect(() => assertSafetyCleared(blocked, confirmation)).toThrow(/print blocked by 1 error/)
  })

  it('deduplicates and sorts the acknowledged codes', () => {
    const messy = createConfirmation(report, 'teller-1', ['MICR_TONER_UNAVAILABLE', 'MICR_TONER_UNAVAILABLE', 'A_CODE', 'B_CODE'])
    expect(messy.acknowledged).toEqual(['A_CODE', 'B_CODE', 'MICR_TONER_UNAVAILABLE'])
  })
})

describe('the report nonce', () => {
  it('is stable for the same situation', () => {
    expect(assessPrintSafety(context()).nonce).toBe(assessPrintSafety(context()).nonce)
  })

  it('changes when anything the operator was shown changes', () => {
    const before = assessPrintSafety(context()).nonce
    expect(assessPrintSafety(context({ calibration: null })).nonce).not.toBe(before)
    expect(assessPrintSafety(context({ data: fixtureData({ payeeName: 'Different payee' }) })).nonce).toBe(before)
    expect(assessPrintSafety(context({ profile: createPrinterProfile({ id: 'other', name: 'Other printer', supportsCustomPageSize: true }, FIXED_AT) }))).not.toMatchObject({ nonce: before })
  })

  it('summarises the whole situation in one line, for the confirmation dialog', () => {
    const report = assessPrintSafety(context())
    expect(report.summary).toContain('NBE personal cheque (English) v1')
    expect(report.summary).toContain('210x85mm')
    expect(report.summary).toContain('3 runs')
    expect(report.summary).toContain(`hash ${fixtureLayout({ template: stock() }).layoutHash}`)
    expect(report.summary).toContain('calibrated 0.4/-0.2mm @ verified')
  })
})
