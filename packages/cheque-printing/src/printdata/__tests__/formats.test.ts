import { describe, expect, it } from 'vitest'
import {
  daysInMonth,
  formatAmount,
  formatAmountInWords,
  formatDate,
  groupDigits,
  isArabicLocale,
  isExactDecimalString,
  isLeapYear,
  padNumber,
  parseIsoDate,
  resolveFieldText,
  splitDecimal,
} from '../formats'
import { AmountInWordsError } from '../../errors'
import type { AmountInWordsConverter, AmountInWordsRequest } from '../../ports/amountInWords'
import type { ChequePrintData } from '../types'

function fakeConverter(overrides: Partial<AmountInWordsConverter> = {}): AmountInWordsConverter {
  return {
    id: 'test-words',
    supportedLocales: ['en', 'ar'],
    convert(request: AmountInWordsRequest) {
      return {
        words: `${request.currency} ${request.decimal} (${request.locale})`,
        converterId: 'test-words',
        usedLocale: request.locale,
      }
    },
    ...overrides,
  }
}

const data = (overrides: Partial<ChequePrintData> = {}): ChequePrintData => ({
  chequeId: null,
  chequeNumber: '1042',
  date: '2026-09-18',
  payeeName: 'عمران للتوريدات',
  amountDecimal: '1500.5',
  currency: 'EGP',
  memo: null,
  reference: null,
  drawerName: null,
  drawerAddress: null,
  bankName: null,
  accountNumber: null,
  ...overrides,
})

describe('date formatting — no Date object, so no timezone can move a cheque date', () => {
  it('parses ISO parts arithmetically', () => {
    expect(parseIsoDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 })
    expect(parseIsoDate('2026-13-01')).toBeNull()
    expect(parseIsoDate('2026-02-29')).toBeNull()
    expect(parseIsoDate('18/09/2026')).toBeNull()
    expect(parseIsoDate('')).toBeNull()
  })

  it('knows leap years and month lengths', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2026)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
  })

  it('renders the supported styles, zero padded', () => {
    expect(formatDate('2026-09-08', 'date-DDMMYYYY', 'en-US')).toBe('08/09/2026')
    expect(formatDate('2026-09-08', 'date-YYYYMMDD', 'en-US')).toBe('2026-09-08')
    expect(formatDate('2026-09-08', 'date-DDMMMYYYY', 'en-US')).toBe('08 Sep 2026')
    expect(formatDate('2026-12-25', 'date-DDMMMYYYY', 'ar-EG')).toBe('25 ديسمبر 2026')
  })

  it('passes through an unparseable date rather than inventing one', () => {
    expect(formatDate('not-a-date', 'date-DDMMYYYY', 'en-US')).toBe('not-a-date')
    expect(formatDate('', 'date-DDMMYYYY', 'en-US')).toBe('')
  })

  it('detects Arabic locales by prefix', () => {
    expect(isArabicLocale('ar')).toBe(true)
    expect(isArabicLocale('ar-EG')).toBe(true)
    expect(isArabicLocale('en-EG')).toBe(false)
  })
})

describe('amount formatting — built from the decimal string, never from a float', () => {
  it('splits exactly', () => {
    expect(splitDecimal('1500.50')).toEqual({ integer: '1500', fraction: '50' })
    expect(splitDecimal('7')).toEqual({ integer: '7', fraction: '' })
    expect(() => splitDecimal('1.234')).toThrow(/at most 2 fractional digits/)
    expect(() => splitDecimal('-5')).toThrow(/exact decimal string/)
  })

  it('validates decimal strings', () => {
    expect(isExactDecimalString('0.10')).toBe(true)
    expect(isExactDecimalString('1e3')).toBe(false)
    expect(isExactDecimalString('1,000')).toBe(false)
  })

  it('pads and groups without float drift', () => {
    expect(formatAmount('1500.1')).toBe('1,500.10')
    expect(formatAmount('0001500.00')).toBe('1,500.00')
    expect(formatAmount('1000000')).toBe('1,000,000.00')
    expect(formatAmount('0.07')).toBe('0.07')
    expect(formatAmount('1500.5', { grouping: false })).toBe('1500.50')
    expect(formatAmount('1500.5', { decimalSeparator: ',', grouping: false, trailingZeros: false })).toBe('1500,5')
    expect(formatAmount('')).toBe('')
    expect(groupDigits('1234567', ',')).toBe('1,234,567')
    expect(groupDigits('12', ',')).toBe('12')
  })

  it('supports an explicit currency symbol', () => {
    expect(formatAmount('12.5', { currencySymbol: 'E£' })).toBe('E£12.50')
  })

  it('pads sequence numbers and reports rather than truncating', () => {
    expect(padNumber('42', 6)).toEqual({ text: '000042', overflowed: false })
    expect(padNumber('A0099', 6)).toEqual({ text: '000099', overflowed: false })
    expect(padNumber('12345678', 6)).toEqual({ text: '12345678', overflowed: true })
  })
})

describe('amount in words goes through the injected port', () => {
  it('calls the converter and reports its identity', () => {
    const converter = fakeConverter()
    const words = formatAmountInWords('1500.50', 'EGP', { converter, locale: 'en-US' })
    expect(words).toBe('EGP 1500.50 (en-US)')
  })

  it('uppercases only when asked', () => {
    const converter = fakeConverter()
    expect(formatAmountInWords('1.00', 'EGP', { converter, locale: 'en-US', uppercase: true })).toBe(
      'EGP 1.00 (EN-US)'
    )
  })

  it('refuses to invent a words line when no converter is available', () => {
    expect(() =>
      formatAmountInWords('1.00', 'EGP', {
        converter: { id: 'unavailable', supportedLocales: [], convert: () => ({ words: '', converterId: 'x', usedLocale: 'en' }) },
        locale: 'en-US',
      })
    ).toThrow(AmountInWordsError)
  })

  it('treats an empty converter result as a failure, not as blank ink', () => {
    const empty = fakeConverter({ convert: () => ({ words: '   ', converterId: 'test-words', usedLocale: 'en-US' }) })
    expect(() => formatAmountInWords('5', 'EGP', { converter: empty, locale: 'en-US' })).toThrow(/empty string/)
  })

  it('resolveFieldText dispatches on the format directive', () => {
    const context = { converter: fakeConverter(), locale: 'en-US' }
    expect(resolveFieldText('date-DDMMYYYY', '2026-09-18', data(), 'en-US')).toBe('18/09/2026')
    expect(resolveFieldText('amount-2dp', '1500.5', data(), 'en-US')).toBe('1,500.50')
    expect(resolveFieldText('number-padded', '99', data(), 'en-US')).toBe('000099')
    expect(resolveFieldText('uppercase', 'payee', data(), 'en-US')).toBe('PAYEE')
    expect(resolveFieldText(undefined, 'x', data(), 'en-US')).toBe('x')
    expect(resolveFieldText('amount-words-en', '', data(), 'en-US', context)).toBe('EGP 1500.5 (en-US)')
    // The words format reads the AMOUNT, not whatever string was handed in for the field.
    expect(resolveFieldText('amount-words-ar', 'ignored', data(), 'en-US', context)).toBe('EGP 1500.5 (ar-EG)')
  })
})
