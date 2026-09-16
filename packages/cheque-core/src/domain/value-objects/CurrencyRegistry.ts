import { UnknownCurrencyError } from '../errors'

/**
 * Resolves how many minor digits (decimal places) a currency uses.
 *
 * Currency is deliberately NOT hardcoded into the domain. `Money` accepts any ISO 4217
 * code as an opaque string; only the minor-digit count needs resolving, and that
 * resolution happens through this port so a host application can supply its own table,
 * fetch it from an API, or register codes the default table does not know.
 */
export interface CurrencyRegistry {
  /**
   * @throws UnknownCurrencyError when the code is not recognised and no default applies.
   */
  minorDigitsOf(currency: string): number

  /** Whether this registry can resolve the given code. */
  isKnown(currency: string): boolean
}

/**
 * ISO 4217 codes that use zero minor digits (no fractional unit in normal use).
 * Kept intentionally short and overridable — this is a convenience default, not a
 * claim of authority. Deployments needing more should register them explicitly.
 */
const ZERO_MINOR_DIGIT_CURRENCIES: ReadonlySet<string> = new Set([
  'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF',
  'XOF', 'XPF',
])

/** ISO 4217 codes that use three minor digits. */
const THREE_MINOR_DIGIT_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
])

export interface DefaultCurrencyRegistryOptions {
  /**
   * Digits to assume for a code that is not in any known table.
   *
   * Defaults to `2`, which is correct for the large majority of currencies. Set to
   * `null` to make unknown codes a hard error instead — recommended once a deployment
   * has registered every currency it actually uses.
   */
  fallbackMinorDigits?: number | null
}

/**
 * Default, extensible {@link CurrencyRegistry}.
 *
 * Registers the common 0-digit and 3-digit ISO codes and falls back to 2 digits, so the
 * domain never embeds a fixed currency list. Additional codes can be registered at
 * runtime, which is how multi-currency and Arabic-market deployments extend it.
 */
export class DefaultCurrencyRegistry implements CurrencyRegistry {
  private readonly overrides = new Map<string, number>()
  private readonly fallbackMinorDigits: number | null

  constructor(options: DefaultCurrencyRegistryOptions = {}) {
    // `?? 2` would swallow an explicit `null`, silently re-enabling the fallback that the
    // caller asked to disable. Distinguish "omitted" from "explicitly null".
    this.fallbackMinorDigits =
      options.fallbackMinorDigits === undefined ? 2 : options.fallbackMinorDigits
  }

  /** Register or override the minor-digit count for a currency code. */
  register(currency: string, minorDigits: number): this {
    const code = DefaultCurrencyRegistry.normalise(currency)
    if (!Number.isInteger(minorDigits) || minorDigits < 0 || minorDigits > 8) {
      throw new UnknownCurrencyError(
        `${currency} (invalid minor digit count ${String(minorDigits)}; expected an integer 0..8)`
      )
    }
    this.overrides.set(code, minorDigits)
    return this
  }

  isKnown(currency: string): boolean {
    const code = DefaultCurrencyRegistry.normalise(currency)
    if (this.overrides.has(code)) return true
    if (ZERO_MINOR_DIGIT_CURRENCIES.has(code)) return true
    if (THREE_MINOR_DIGIT_CURRENCIES.has(code)) return true
    return this.fallbackMinorDigits !== null
  }

  minorDigitsOf(currency: string): number {
    const code = DefaultCurrencyRegistry.normalise(currency)

    const override = this.overrides.get(code)
    if (override !== undefined) return override

    if (ZERO_MINOR_DIGIT_CURRENCIES.has(code)) return 0
    if (THREE_MINOR_DIGIT_CURRENCIES.has(code)) return 3

    if (this.fallbackMinorDigits !== null) return this.fallbackMinorDigits

    throw new UnknownCurrencyError(currency)
  }

  /**
   * Validate and normalise an ISO 4217-style code.
   * Accepts 3 ASCII letters (the ISO convention) and upper-cases it so that `egp`
   * and `EGP` resolve identically.
   */
  static normalise(currency: string): string {
    if (typeof currency !== 'string') {
      throw new UnknownCurrencyError(String(currency))
    }
    const code = currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new UnknownCurrencyError(currency)
    }
    return code
  }
}
