/**
 * Construction and validation of the print payload.
 *
 * Validation lives here, at the edge where foreign data (a form, an import, an API request)
 * becomes print data, so the layout engine downstream can be a pure function that assumes clean
 * input. The engine still re-checks the geometry; it does not re-check the arithmetic of a date.
 */

import { isExactDecimalString, parseIsoDate } from './formats'
import type { ChequePrintData, PrintDataIssue } from './types'

export interface CreatePrintDataOptions {
  /** When false (default), an invalid payload throws instead of returning partial data. */
  readonly lenient?: boolean
}

export function createChequePrintData(
  input: Partial<ChequePrintData> & Pick<ChequePrintData, 'chequeNumber' | 'date' | 'payeeName' | 'amountDecimal' | 'currency'>,
  options: CreatePrintDataOptions = {}
): ChequePrintData {
  const issues = validateChequePrintData(input)
  const errors = issues.filter((issue) => issue.severity === 'error')
  if (errors.length > 0 && options.lenient !== true) {
    throw new TypeError(
      `cheque print data is not printable: ${errors.map((issue) => `${issue.code} (${issue.message})`).join('; ')}`
    )
  }
  return normalise(input)
}

export function validateChequePrintData(
  input: Partial<ChequePrintData>
): PrintDataIssue[] {
  const issues: PrintDataIssue[] = []

  if (typeof input.chequeNumber !== 'string' || input.chequeNumber.trim() === '') {
    issues.push({
      code: 'CHEQUE_NUMBER_REQUIRED',
      severity: 'error',
      message: 'a cheque number is required — the physical stock is already numbered, and an unnumbered print is an unauditable one',
    })
  }

  if (typeof input.date !== 'string' || parseIsoDate(input.date) === null) {
    issues.push({
      code: 'DATE_MALFORMED',
      severity: 'error',
      message: `cheque date must be an exact calendar date as YYYY-MM-DD, got "${String(input.date)}"`,
    })
  }

  if (typeof input.payeeName !== 'string' || input.payeeName.trim() === '') {
    issues.push({
      code: 'PAYEE_REQUIRED',
      severity: 'error',
      message: 'payee name is required (a bearer cheque is a deliberate, different product)',
    })
  }

  const amount = input.amountDecimal
  if (typeof amount !== 'string' || amount.trim() === '') {
    issues.push({ code: 'AMOUNT_MALFORMED', severity: 'error', message: 'amount is required as an exact decimal string' })
  } else if (amount.trim().startsWith('-')) {
    issues.push({
      code: 'AMOUNT_NEGATIVE',
      severity: 'error',
      message: 'negative amounts are not printable on a cheque — void or re-issue the instrument instead',
    })
  } else if (!isExactDecimalString(amount)) {
    issues.push({
      code: 'AMOUNT_MALFORMED',
      severity: 'error',
      message: `amount must be an exact decimal string with at most 2 fractional digits, got "${amount}"`,
    })
  } else if ((amount.split('.')[0] ?? '').length > 13) {
    issues.push({
      code: 'AMOUNT_TOO_LARGE',
      severity: 'warning',
      message: 'amount exceeds 13 integer digits; verify it fits the words line of this stock',
    })
  }

  // Case is normalised on the way in (`normalise`), so a lower-case code is not an error — but a
  // two-letter or punctuated one is, because it would not survive an export/import round trip.
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : input.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    issues.push({
      code: 'CURRENCY_MALFORMED',
      severity: 'error',
      message: `currency must be a 3-letter ISO 4217 code (use XXX for "no currency"), got "${String(currency)}"`,
    })
  }

  if (input.custom !== undefined) {
    for (const [key, value] of Object.entries(input.custom)) {
      if (value !== null && typeof value !== 'string') {
        issues.push({
          code: 'CUSTOM_VALUE_NOT_A_STRING',
          severity: 'error',
          message: `custom field "${key}" must be a string or null — the engine will not stringify a number or an object`,
        })
      }
    }
  }

  return issues
}

function normalise(input: Partial<ChequePrintData>): ChequePrintData {
  const data: ChequePrintData = {
    chequeId: input.chequeId ?? null,
    chequeNumber: (input.chequeNumber ?? '').trim(),
    date: (input.date ?? '').trim(),
    payeeName: (input.payeeName ?? '').trim(),
    amountDecimal: (input.amountDecimal ?? '').trim(),
    currency: (input.currency ?? '').trim().toUpperCase(),
    memo: nullify(input.memo),
    reference: nullify(input.reference),
    drawerName: nullify(input.drawerName),
    drawerAddress: nullify(input.drawerAddress),
    bankName: nullify(input.bankName),
    accountNumber: nullify(input.accountNumber),
    amountWords: nullify(input.amountWords),
    locale: input.locale ?? 'en-US',
    directionHint: input.directionHint ?? 'auto',
    custom: input.custom === undefined ? undefined : Object.freeze({ ...input.custom }),
  }
  return Object.freeze(data)
}

function nullify(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
