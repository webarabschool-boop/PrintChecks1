/**
 * Amount-in-words port.
 *
 * A cheque's words line is the amount a bank will pay when the digits and the words disagree, so
 * it is a financial rendering, not a string trick. Two rules follow from that:
 *
 * 1. **This package does not implement number-to-words.** The monorepo already has an approved
 *    implementation (`to-words`, wired in `printchecks/src/stores/check.ts`), and a second one
 *    inside the printing engine would be a second set of rules to keep in sync — the exact
 *    drift Phase 1 was created to remove. The engine declares what it needs; the application
 *    injects the implementation.
 * 2. **The amount arrives as an exact decimal string.** Handing a float to a converter is how
 *    `1500.1` becomes "fifteen hundred and one tenth of a dollar". The port signature makes a
 *    float a type error.
 */

export interface AmountInWordsRequest {
  /** Exact decimal string, e.g. `'1500.00'`. Two decimal places maximum. */
  readonly decimal: string
  /** ISO 4217 code. `'XXX'` means "no currency" and must be rendered without a unit word. */
  readonly currency: string
  /** BCP-47 locale, e.g. `'en-US'`, `'ar-EG'`. */
  readonly locale: string
  /** Append the fractional unit explicitly (`... and 50/100`) instead of a word form. */
  readonly fractionStyle?: 'words' | 'numeric-fraction' | 'none'
  /** Uppercase the result — Arabic and English stocks both have all-caps words lines. */
  readonly uppercase?: boolean
}

export interface AmountInWordsResult {
  readonly words: string
  /** Which implementation produced it, so an audit record can attribute the rendering. */
  readonly converterId: string
  /** Locale actually used after fallback, e.g. `'ar-EG'` → `'ar'`. */
  readonly usedLocale: string
}

export interface AmountInWordsConverter {
  readonly id: string
  /** Locales this converter can render. `'en'` matches `'en-US'` — see {@link localeIsSupported}. */
  readonly supportedLocales: readonly string[]
  convert(request: AmountInWordsRequest): AmountInWordsResult
}

/** Prefix-style locale match: `'ar'` covers `'ar-EG'`, `'ar_EG'` and `'ar'`. */
export function localeIsSupported(converter: AmountInWordsConverter, locale: string): boolean {
  return converter.supportedLocales.some((supported) => {
    const base = supported.toLowerCase().replace('_', '-')
    const wanted = locale.toLowerCase().replace('_', '-')
    return wanted === base || wanted.startsWith(`${base}-`)
  })
}

/**
 * No converter injected → the engine refuses to invent words. A silently empty words line on a
 * cheque is a fraud vector, so this is an error path, not a fallback.
 */
export class UnavailableAmountInWordsConverter implements AmountInWordsConverter {
  readonly id = 'unavailable'
  readonly supportedLocales: readonly string[] = []

  convert(): AmountInWordsResult {
    throw new Error('no amount-in-words converter is injected')
  }
}
