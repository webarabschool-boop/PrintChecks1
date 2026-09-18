/**
 * The print payload.
 *
 * **This is deliberately not a cheque entity.** `@printchecks/cheque-core` owns what a cheque
 * *is* (Bank → BankAccount → ChequeBook → Cheque, Money, lifecycle, numbering); this package owns
 * only *what has to land on the paper*. The application boundary maps a `Cheque` into this shape
 * and nothing else, which keeps the printing engine usable from a backend, a worker or a CLI, and
 * keeps two packages from owning the same model.
 *
 * Every value is an exact string. Amounts arrive as a decimal string rather than a number because
 * a float cannot represent 0.10 and the engine must never re-round a financial value; cheque
 * numbers arrive as strings for the same reason the core treats them as strings — leading zeros and
 * manual punctuation like `0012/2026-SB` are data, not formatting.
 */

export interface ChequePrintData {
  /** Domain identity, recorded on the print job for attribution. Never used for geometry. */
  readonly chequeId: string | null
  /** Exact string: prefixes, leading zeros and punctuation are preserved verbatim. */
  readonly chequeNumber: string
  /** `YYYY-MM-DD`. Parsed arithmetically — no `Date`, so no timezone can shift a date. */
  readonly date: string
  readonly payeeName: string
  /** Exact decimal, e.g. `'1500.00'`. Max two decimal places. */
  readonly amountDecimal: string
  /** ISO 4217 code. `'XXX'` is the core's explicit "no currency" sentinel and is honoured. */
  readonly currency: string
  readonly memo: string | null
  readonly reference: string | null
  readonly drawerName: string | null
  readonly drawerAddress: string | null
  readonly bankName: string | null
  readonly accountNumber: string | null
  /**
   * The words line. When absent, the engine produces it through the injected
   * `AmountInWordsConverter` port — the engine never ships its own number-to-words table.
   */
  readonly amountWords?: string | null
  /** Locale used for amount-in-words and month names. */
  readonly locale?: string
  /** Overrides the template's bidi default for this cheque (mixed-script payees). */
  readonly directionHint?: 'ltr' | 'rtl' | 'auto'
  /** Values for template fields with custom keys, addressed by `customKey`. */
  readonly custom?: Readonly<Record<string, string | null>>
}

export const CHEQUE_PRINT_DATA_FIELDS = [
  'chequeNumber',
  'date',
  'payeeName',
  'amountDecimal',
  'amountWords',
  'currency',
  'memo',
  'reference',
  'drawerName',
  'drawerAddress',
  'bankName',
  'accountNumber',
] as const satisfies readonly (keyof ChequePrintData)[]

export interface PrintDataIssue {
  readonly code:
    | 'CHEQUE_NUMBER_REQUIRED'
    | 'DATE_MALFORMED'
    | 'DATE_OUT_OF_RANGE'
    | 'PAYEE_REQUIRED'
    | 'AMOUNT_MALFORMED'
    | 'AMOUNT_NEGATIVE'
    | 'AMOUNT_TOO_LARGE'
    | 'CURRENCY_MALFORMED'
    | 'CUSTOM_VALUE_NOT_A_STRING'
  readonly message: string
  readonly severity: 'error' | 'warning'
}
