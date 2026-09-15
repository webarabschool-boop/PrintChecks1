import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../errors'
import { DefaultCurrencyRegistry, type CurrencyRegistry } from './CurrencyRegistry'

/** Rounding policy applied when a decimal string carries more precision than the currency supports. */
export type MoneyRounding = 'half-up' | 'half-even' | 'down' | 'up' | 'reject'

/** Accepted forms when parsing an amount. A binary `number` is deliberately absent. */
export type MoneyDecimalInput = string

export interface MoneyJson {
  minorUnits: number
  currency: string
}

const DECIMAL_PATTERN = /^[+-]?[0-9]+(?:\.[0-9]+)?$/

const sharedRegistry = new DefaultCurrencyRegistry()

function bigPowerOfTen(exponent: number): bigint {
  let result = 1n
  for (let i = 0; i < exponent; i += 1) result *= 10n
  return result
}

function toSafeInteger(value: bigint, context: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyOverflowError(`${context} produced ${value.toString()}, outside the safe integer range`)
  }
  return Number(value)
}

/**
 * Money — an exact monetary value object.
 *
 * Represented as an INTEGER count of minor units plus an ISO 4217 currency code.
 * Binary floating point is never used for storage or arithmetic: parsing and
 * formatting go through `BigInt`, and the stored `minorUnits` is always a safe integer.
 *
 * This replaces the legacy `amount: string | number` design
 * (`packages/core/src/models/Check.ts:26`) and the ~62 `parseFloat` money sites in the
 * existing codebase, where `0.1 + 0.2 !== 0.3` and `1.005` rounds unpredictably.
 *
 * Deliberately there is NO `fromNumber(1.005)` style constructor. Amounts enter the
 * domain either as exact minor units (`fromMinorUnits`) or as exact decimal strings
 * (`fromDecimalString`), so a lossy binary double can never become the source of truth.
 *
 * Currency is not hardcoded: any 3-letter code is accepted and its minor-digit count is
 * resolved through an injectable {@link CurrencyRegistry}.
 */
export class Money {
  /** Integer count of the currency's minor units. May be negative. */
  readonly minorUnits: number
  /** Normalised (upper-cased, trimmed) ISO 4217 code. */
  readonly currency: string

  private constructor(minorUnits: number, currency: string) {
    if (!Number.isSafeInteger(minorUnits)) {
      throw new InvalidMoneyError(
        `minorUnits must be a safe integer, received ${String(minorUnits)}. ` +
          `Floating-point monetary values are not permitted.`
      )
    }
    this.minorUnits = minorUnits
    this.currency = DefaultCurrencyRegistry.normalise(currency)
  }

  /** Construct from an exact integer count of minor units. */
  static fromMinorUnits(minorUnits: number, currency: string): Money {
    if (typeof minorUnits !== 'number' || !Number.isSafeInteger(minorUnits)) {
      throw new InvalidMoneyError(
        `minorUnits must be a safe integer, received ${String(minorUnits)}. ` +
          `Use fromDecimalString("12.34") for decimal input instead of passing a float.`
      )
    }
    return new Money(minorUnits, currency)
  }

  /**
   * Construct from an exact decimal string such as `"1234.56"`, `"0.01"` or `"-5"`.
   *
   * Parsed with `BigInt` string arithmetic — the input never becomes a JS float, so
   * values like `"1.005"` or `"0.1"` are represented exactly.
   *
   * @param minorDigits  explicit precision; when omitted it is resolved from `registry`.
   * @param rounding     policy when the input has more decimals than the currency allows.
   *                     Defaults to `half-up`. Use `reject` to make over-precise input an error.
   * @throws InvalidMoneyError on malformed input or an unrepresentable rounding policy.
   */
  static fromDecimalString(
    input: MoneyDecimalInput,
    currency: string,
    options: {
      minorDigits?: number
      rounding?: MoneyRounding
      registry?: CurrencyRegistry
    } = {}
  ): Money {
    if (typeof input !== 'string') {
      throw new InvalidMoneyError(
        `expected a decimal string, received ${input === null ? 'null' : typeof input}. ` +
          `Passing a binary float is not permitted because it may already be imprecise.`
      )
    }

    const trimmed = input.trim()
    if (!DECIMAL_PATTERN.test(trimmed)) {
      throw new InvalidMoneyError(`"${input}" is not a valid decimal amount (expected e.g. "1234.56")`)
    }

    const code = DefaultCurrencyRegistry.normalise(currency)
    const registry = options.registry ?? sharedRegistry
    const minorDigits = options.minorDigits ?? registry.minorDigitsOf(code)

    if (!Number.isInteger(minorDigits) || minorDigits < 0 || minorDigits > 8) {
      throw new InvalidMoneyError(`minorDigits must be an integer 0..8, received ${String(minorDigits)}`)
    }

    const rounding: MoneyRounding = options.rounding ?? 'half-up'

    const negative = trimmed.startsWith('-')
    const unsigned = trimmed.startsWith('+') || negative ? trimmed.slice(1) : trimmed

    const dotIndex = unsigned.indexOf('.')
    const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex)
    const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1)

    if (intPart.length === 0) {
      throw new InvalidMoneyError(`"${input}" has no integer part`)
    }

    let kept: string
    let rest: string
    if (fracPart.length <= minorDigits) {
      kept = fracPart.padEnd(minorDigits, '0')
      rest = ''
    } else {
      kept = fracPart.slice(0, minorDigits)
      rest = fracPart.slice(minorDigits)
    }

    const scale = bigPowerOfTen(minorDigits)
    let magnitude = BigInt(intPart) * scale + BigInt(kept.length === 0 ? '0' : kept)

    if (rest.length > 0) {
      const increment = Money.shouldRoundUp(kept, rest, rounding, input)
      if (increment) magnitude += 1n
    }

    const signed = negative ? -magnitude : magnitude
    return new Money(toSafeInteger(signed, `fromDecimalString("${input}")`), code)
  }

  /** Zero amount in the given currency. */
  static zero(currency: string, options: { registry?: CurrencyRegistry } = {}): Money {
    const code = DefaultCurrencyRegistry.normalise(currency)
    // Resolve eagerly so an unregistered currency fails here rather than later.
    ;(options.registry ?? sharedRegistry).minorDigitsOf(code)
    return new Money(0, code)
  }

  private static shouldRoundUp(
    kept: string,
    rest: string,
    rounding: MoneyRounding,
    original: string
  ): boolean {
    const firstRest = rest.charAt(0)
    // Digits beyond the first decide whether the remainder is EXACTLY half or more.
    const beyondFirst = rest.slice(1)
    const restHasNonZero = /[1-9]/.test(rest)
    const moreThanHalf = /[1-9]/.test(beyondFirst)

    switch (rounding) {
      case 'down':
        return false
      case 'up':
        return restHasNonZero
      case 'half-up':
        return firstRest >= '5'
      case 'half-even': {
        if (firstRest > '5') return true
        if (firstRest < '5') return false
        // Exactly half (first digit 5, nothing after it): round to even.
        if (moreThanHalf) return true
        const lastKeptDigit = kept.length === 0 ? 0 : Number.parseInt(kept.charAt(kept.length - 1), 10)
        return lastKeptDigit % 2 === 1
      }
      case 'reject':
        throw new InvalidMoneyError(
          `"${original}" carries more precision than the currency supports and rounding policy is "reject"`
        )
      default:
        throw new InvalidMoneyError(`unknown rounding policy "${String(rounding)}"`)
    }
  }

  /** Number of minor digits this value's currency uses. */
  minorDigits(registry: CurrencyRegistry = sharedRegistry): number {
    return registry.minorDigitsOf(this.currency)
  }

  /** Exact decimal representation, e.g. `1234` minor units in a 2-digit currency -> `"12.34"`. */
  toDecimalString(registry: CurrencyRegistry = sharedRegistry): string {
    const digits = this.minorDigits(registry)
    const scale = bigPowerOfTen(digits)
    const magnitude = BigInt(this.minorUnits)
    const negative = magnitude < 0n
    const absolute = negative ? -magnitude : magnitude

    const intPart = (absolute / scale).toString()
    const fracPart = (absolute % scale).toString().padStart(digits, '0')

    const body = digits === 0 ? intPart : `${intPart}.${fracPart}`
    return negative ? `-${body}` : body
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency)
    }
    // `operation` is part of the error contract for callers that catch and re-wrap.
    if (operation.length === 0) {
      throw new InvalidMoneyError('operation name must not be empty')
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, 'add')
    return new Money(
      toSafeInteger(BigInt(this.minorUnits) + BigInt(other.minorUnits), 'addition'),
      this.currency
    )
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract')
    return new Money(
      toSafeInteger(BigInt(this.minorUnits) - BigInt(other.minorUnits), 'subtraction'),
      this.currency
    )
  }

  /** Multiply by an exact integer. Fractional multiplication would reintroduce rounding. */
  multiplyByInteger(factor: number): Money {
    if (!Number.isSafeInteger(factor)) {
      throw new InvalidMoneyError(
        `multiplication factor must be a safe integer, received ${String(factor)}. ` +
          `Fractional factors would reintroduce floating-point error; split the operation instead.`
      )
    }
    return new Money(
      toSafeInteger(BigInt(this.minorUnits) * BigInt(factor), 'multiplication'),
      this.currency
    )
  }

  negate(): Money {
    return new Money(toSafeInteger(-BigInt(this.minorUnits), 'negation'), this.currency)
  }

  abs(): Money {
    return this.minorUnits < 0 ? this.negate() : this
  }

  isZero(): boolean {
    return this.minorUnits === 0
  }

  isPositive(): boolean {
    return this.minorUnits > 0
  }

  isNegative(): boolean {
    return this.minorUnits < 0
  }

  equals(other: Money | null | undefined): boolean {
    return (
      other instanceof Money &&
      other.currency === this.currency &&
      other.minorUnits === this.minorUnits
    )
  }

  compareTo(other: Money): number {
    this.assertSameCurrency(other, 'compareTo')
    if (this.minorUnits < other.minorUnits) return -1
    if (this.minorUnits > other.minorUnits) return 1
    return 0
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0
  }

  /**
   * Sum a collection of amounts. Exact regardless of length — the classic
   * floating-point failure `0.1 + 0.2 === 0.30000000000000004` cannot occur.
   *
   * @throws CurrencyMismatchError if the collection mixes currencies.
   */
  static sum(values: readonly Money[], currency: string): Money {
    const code = DefaultCurrencyRegistry.normalise(currency)
    let total = 0n
    for (const value of values) {
      if (value.currency !== code) {
        throw new CurrencyMismatchError(code, value.currency)
      }
      total += BigInt(value.minorUnits)
    }
    return new Money(toSafeInteger(total, 'sum'), code)
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`
  }

  /** Serialises as `{ minorUnits, currency }` — an integer, never a float. */
  toJSON(): MoneyJson {
    return { minorUnits: this.minorUnits, currency: this.currency }
  }

  static fromJSON(json: MoneyJson): Money {
    if (json === null || typeof json !== 'object') {
      throw new InvalidMoneyError('expected an object of shape { minorUnits, currency }')
    }
    return Money.fromMinorUnits(json.minorUnits, json.currency)
  }
}
