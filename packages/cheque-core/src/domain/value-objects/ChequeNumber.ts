import { InvalidChequeNumberError } from '../errors'

/**
 * ChequeNumber — an opaque STRING value object.
 *
 * LOCKED REQUIREMENT: a cheque number is not necessarily numeric. Real books use
 * `4567`, `A4567`, `A0001`, and other configured alphanumeric formats. Therefore:
 *
 *   - the value is modelled and persisted as a `string`, never as a number;
 *   - the COMPLETE cheque number is never passed to `parseInt`, `Number`, unary `+`,
 *     or any other numeric coercion;
 *   - the exact string is preserved for display, search, reporting, printing,
 *     import/export and auditing — including leading zeros.
 *
 * The only numeric component anywhere in this system is the *sequence counter* inside
 * a {@link ChequeBookSequence}, which is a separate, explicitly-numeric concept and is
 * never derived by parsing a complete cheque number.
 *
 * @see ChequeBookSequence for how numbers are generated from prefix + sequence + width.
 */
export class ChequeNumber {
  /** Practical upper bound; generous enough for any real bank format. */
  static readonly MAX_LENGTH = 64

  private readonly _value: string

  private constructor(value: string) {
    this._value = value
  }

  /**
   * Create a ChequeNumber from an exact string.
   *
   * The value is preserved verbatim. It is NOT trimmed of interior characters, NOT
   * zero-normalised and NOT numerically interpreted. Only obviously-invalid input is
   * rejected (empty, whitespace-only, leading/trailing whitespace, control characters,
   * excessive length) so that a mis-keyed value cannot be silently persisted.
   *
   * @throws InvalidChequeNumberError
   */
  static of(raw: unknown): ChequeNumber {
    if (typeof raw !== 'string') {
      throw new InvalidChequeNumberError(
        `expected a string, received ${raw === null ? 'null' : typeof raw}. ` +
          `A cheque number must never be modelled as a numeric value.`,
        typeof raw === 'number' ? String(raw) : undefined
      )
    }

    if (raw.length === 0) {
      throw new InvalidChequeNumberError('must not be empty', raw)
    }

    if (raw.length > ChequeNumber.MAX_LENGTH) {
      throw new InvalidChequeNumberError(
        `exceeds maximum length of ${ChequeNumber.MAX_LENGTH} characters`,
        raw
      )
    }

    // Control characters are checked BEFORE whitespace: a newline is both, and the more
    // specific diagnosis is the useful one (it would corrupt MICR bands, CSV and print).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(raw)) {
      throw new InvalidChequeNumberError('must not contain control characters', raw)
    }

    if (raw !== raw.trim()) {
      throw new InvalidChequeNumberError('must not have leading or trailing whitespace', raw)
    }

    if (/\s/.test(raw)) {
      throw new InvalidChequeNumberError('must not contain whitespace', raw)
    }

    return new ChequeNumber(raw)
  }

  /** The exact, unmodified cheque number string. */
  get value(): string {
    return this._value
  }

  /** Length of the exact string, including any leading zeros. */
  get length(): number {
    return this._value.length
  }

  /**
   * Informational only: whether the string consists solely of ASCII digits.
   *
   * This never coerces the value and must not be used to derive a sequence position.
   */
  isNumericOnly(): boolean {
    return /^[0-9]+$/.test(this._value)
  }

  equals(other: ChequeNumber | null | undefined): boolean {
    return other instanceof ChequeNumber && other._value === this._value
  }

  /** Case-sensitive exact comparison, as required for duplicate detection. */
  compareTo(other: ChequeNumber): number {
    return this._value < other._value ? -1 : this._value > other._value ? 1 : 0
  }

  toString(): string {
    return this._value
  }

  /** Serialises as the bare string so JSON/DB/API payloads carry the exact value. */
  toJSON(): string {
    return this._value
  }

  static fromJSON(value: unknown): ChequeNumber {
    return ChequeNumber.of(value)
  }
}
