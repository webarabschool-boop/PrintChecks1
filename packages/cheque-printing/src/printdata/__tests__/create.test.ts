import { describe, expect, it } from 'vitest'
import { createChequePrintData, validateChequePrintData } from '../create'

const valid = {
  chequeNumber: '0012/2026-SB',
  date: '2026-09-18',
  payeeName: 'Crescent Trading',
  amountDecimal: '1500.00',
  currency: 'EGP',
}

describe('print data validation at the edge', () => {
  it('accepts a clean payload and freezes it', () => {
    const data = createChequePrintData(valid)
    expect(data.chequeNumber).toBe('0012/2026-SB')
    expect(data.memo).toBeNull()
    expect(Object.isFrozen(data)).toBe(true)
  })

  it('preserves the cheque number as an exact string — leading zeros and punctuation included', () => {
    expect(createChequePrintData({ ...valid, chequeNumber: '0007' }).chequeNumber).toBe('0007')
    expect(createChequePrintData({ ...valid, chequeNumber: 'A0099' }).chequeNumber).toBe('A0099')
  })

  it('upper-cases the currency and blanks optional text', () => {
    const data = createChequePrintData({ ...valid, currency: 'usd', memo: '   ', drawerName: ' A. Farmer ' })
    expect(data.currency).toBe('USD')
    expect(data.memo).toBeNull()
    expect(data.drawerName).toBe('A. Farmer')
  })

  it('honours the XXX "no currency" sentinel instead of guessing', () => {
    expect(validateChequePrintData({ ...valid, currency: 'XXX' })).toEqual([])
  })

  it('rejects the things that would print a wrong number', () => {
    const codes = validateChequePrintData({
      chequeNumber: '',
      date: '18/09/2026',
      payeeName: '  ',
      amountDecimal: '1500.123',
      currency: 'euro',
    }).map((issue) => issue.code)
    expect(codes).toContain('CHEQUE_NUMBER_REQUIRED')
    expect(codes).toContain('DATE_MALFORMED')
    expect(codes).toContain('PAYEE_REQUIRED')
    expect(codes).toContain('AMOUNT_MALFORMED')
    expect(codes).toContain('CURRENCY_MALFORMED')
  })

  it('accepts a lower-case currency code because the case is normalised', () => {
    expect(validateChequePrintData({ ...valid, currency: 'egp' })).toEqual([])
    expect(createChequePrintData({ ...valid, currency: 'egp' }).currency).toBe('EGP')
  })

  it('refuses a negative amount rather than printing it', () => {
    const issues = validateChequePrintData({ ...valid, amountDecimal: '-5.00' })
    expect(issues.some((issue) => issue.code === 'AMOUNT_NEGATIVE')).toBe(true)
    expect(() => createChequePrintData({ ...valid, amountDecimal: '-5.00' })).toThrow(/not printable/)
  })

  it('warns, rather than fails, on an amount too long for a words line', () => {
    const issues = validateChequePrintData({ ...valid, amountDecimal: '12345678901234.00' })
    expect(issues.some((issue) => issue.code === 'AMOUNT_TOO_LARGE' && issue.severity === 'warning')).toBe(true)
  })

  it('rejects a calendar-impossible date', () => {
    expect(validateChequePrintData({ ...valid, date: '2026-02-30' }).some((i) => i.code === 'DATE_MALFORMED')).toBe(true)
  })

  it('requires custom values to be strings', () => {
    const issues = validateChequePrintData({
      ...valid,
      custom: { branchCode: 12 as unknown as string },
    })
    expect(issues.some((issue) => issue.code === 'CUSTOM_VALUE_NOT_A_STRING')).toBe(true)
  })

  it('lenient mode reports instead of throwing, for the designer', () => {
    const data = createChequePrintData({ ...valid, amountDecimal: 'oops' }, { lenient: true })
    expect(data.amountDecimal).toBe('oops')
  })
})
