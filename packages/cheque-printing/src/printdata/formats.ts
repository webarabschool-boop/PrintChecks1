/**
 * Format directives resolved by the layout engine.
 *
 * Everything here is pure and locale-table driven on purpose: `new Date('2026-09-18')` parses as
 * midnight UTC but formats in *local* time, so a machine west of Greenwich renders the day before.
 * A cheque printed with the wrong date is a void cheque, so dates are parsed from their ISO parts
 * arithmetically and never through `Date`.
 */

import type { AmountInWordsConverter } from '../ports/amountInWords'
import { AmountInWordsError } from '../errors'
import type { TemplateFormat } from '../template/types'
import type { ChequePrintData } from './types'

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DECIMAL_PATTERN = /^\d+(?:\.\d{1,2})?$/

const MONTH_NAMES_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
]

export interface IsoDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

export function parseIsoDate(value: string): IsoDateParts | null {
  const match = ISO_DATE_PATTERN.exec(value.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function formatDate(value: string, style: 'date-DDMMYYYY' | 'date-DDMMMYYYY' | 'date-YYYYMMDD', locale: string): string {
  const parts = parseIsoDate(value)
  if (parts === null) return value.trim() === '' ? '' : value
  const dd = String(parts.day).padStart(2, '0')
  const mm = String(parts.month).padStart(2, '0')
  const yyyy = String(parts.year)
  if (style === 'date-YYYYMMDD') return `${yyyy}-${mm}-${dd}`
  if (style === 'date-DDMMYYYY') return `${dd}/${mm}/${yyyy}`
  const monthNames = isArabicLocale(locale) ? MONTH_NAMES_AR : MONTH_NAMES_EN
  const name = monthNames[parts.month - 1] ?? ''
  return `${dd} ${name} ${yyyy}`
}

export function isArabicLocale(locale: string): boolean {
  return /^ar([-_]|$)/i.test(locale)
}

/** Split an exact decimal string into integer/fraction parts without going through a float. */
export function splitDecimal(decimal: string): { integer: string; fraction: string } {
  const trimmed = decimal.trim()
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new TypeError(`amount must be an exact decimal string with at most 2 fractional digits, got "${decimal}"`)
  }
  const dot = trimmed.indexOf('.')
  if (dot === -1) return { integer: trimmed, fraction: '' }
  return { integer: trimmed.slice(0, dot), fraction: trimmed.slice(dot + 1) }
}

export function isExactDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value.trim())
}

export interface AmountFormatOptions {
  readonly grouping?: boolean
  readonly groupSeparator?: string
  readonly decimalSeparator?: string
  readonly currencySymbol?: string | null
  readonly trailingZeros?: boolean
}

/**
 * Render the numeric amount box: grouped thousands, exactly two decimals. Built from the decimal
 * *string*, so `1000.1` → `1,000.10` and never `1000.0999999999999`.
 */
export function formatAmount(value: string, options: AmountFormatOptions = {}): string {
  if (value.trim() === '') return ''
  const { integer, fraction } = splitDecimal(value)
  const grouping = options.grouping ?? true
  const groupSeparator = options.groupSeparator ?? ','
  const decimalSeparator = options.decimalSeparator ?? '.'
  const trailingZeros = options.trailingZeros ?? true

  const integerDigits = integer.replace(/^0+(?=\d)/, '')
  const grouped = grouping ? groupDigits(integerDigits, groupSeparator) : integerDigits
  const fractionPart = trailingZeros ? fraction.padEnd(2, '0').slice(0, 2) : fraction
  const amount = fractionPart.length > 0 ? `${grouped}${decimalSeparator}${fractionPart}` : grouped
  const symbol = options.currencySymbol ?? null
  return symbol === null || symbol === '' ? amount : `${symbol}${amount}`
}

export function groupDigits(digits: string, separator: string): string {
  const out: string[] = []
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out.push(separator)
    const char = digits[index]
    if (char !== undefined) out.push(char)
  }
  return out.join('')
}

/** `number-padded`: leading zeros for pre-printed sequence boxes. Longer values are not truncated. */
export function padNumber(value: string, width = 6): { text: string; overflowed: boolean } {
  const digits = value.replace(/\D/g, '')
  if (digits.length > width) return { text: digits, overflowed: true }
  return { text: digits.padStart(width, '0'), overflowed: false }
}

export interface WordsFormatContext {
  readonly converter: AmountInWordsConverter
  readonly locale: string
  /** `'numeric-fraction'` renders `... and 50/100`, which is what most bank stocks expect. */
  readonly fractionStyle?: 'words' | 'numeric-fraction' | 'none'
  readonly uppercase?: boolean
}

/**
 * Amount-in-words, produced by the injected converter. The engine supplies locale selection and
 * the uppercase policy, and reports which converter rendered the line; it contributes no wording
 * of its own.
 */
export function formatAmountInWords(amount: string, currency: string, context: WordsFormatContext): string {
  if (amount.trim() === '') return ''
  if (context.converter.id === 'unavailable') {
    throw new AmountInWordsError(
      'a field requests amount-in-words but no AmountInWordsConverter is injected — ' +
        'refusing to print an empty or invented words line'
    )
  }
  const result = context.converter.convert({
    decimal: amount,
    currency,
    locale: context.locale,
    ...(context.fractionStyle === undefined ? {} : { fractionStyle: context.fractionStyle }),
    ...(context.uppercase === undefined ? {} : { uppercase: context.uppercase }),
  })
  const words = result.words.trim()
  if (words === '') {
    throw new AmountInWordsError(
      `amount-in-words converter "${context.converter.id}" returned an empty string for ${amount} ${currency}`
    )
  }
  return context.uppercase ?? false ? words.toUpperCase() : words
}

export function monthNamesFor(locale: string): readonly string[] {
  return isArabicLocale(locale) ? MONTH_NAMES_AR : MONTH_NAMES_EN
}

/** Which data source a canonical field key reads from, unless the template overrides it. */
export function resolveFieldText(
  format: TemplateFormat | undefined,
  rawValue: string,
  data: ChequePrintData,
  locale: string,
  wordsContext?: WordsFormatContext
): string {
  switch (format) {
    case 'date-DDMMYYYY':
      return formatDate(rawValue, 'date-DDMMYYYY', locale)
    case 'date-DDMMMYYYY':
      return formatDate(rawValue, 'date-DDMMMYYYY', locale)
    case 'date-YYYYMMDD':
      return formatDate(rawValue, 'date-YYYYMMDD', locale)
    case 'amount-2dp':
      return rawValue.trim() === '' ? '' : formatAmount(rawValue)
    case 'amount-words-en':
      return wordsContext === undefined
        ? rawValue
        : formatAmountInWords(data.amountDecimal, data.currency, { ...wordsContext, locale: 'en-US' })
    case 'amount-words-ar':
      return wordsContext === undefined
        ? rawValue
        : formatAmountInWords(data.amountDecimal, data.currency, {
            ...wordsContext,
            locale: isArabicLocale(locale) ? locale : 'ar-EG',
          })
    case 'number-padded':
      return padNumber(rawValue).text
    case 'uppercase':
      return rawValue.toUpperCase()
    case 'text':
    case undefined:
      return rawValue
    default:
      return rawValue
  }
}
