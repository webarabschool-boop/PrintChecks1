import { ChequeNumber } from '../value-objects/ChequeNumber'
import { ChequeBookExhaustedError, InvalidChequeBookSequenceError } from '../errors'

/**
 * How a cheque book produces numbers.
 *
 * - `numeric`       — digits only, e.g. `4567`. Prefix must be empty.
 * - `alphanumeric`  — a fixed prefix plus digits, e.g. `A4567`, `A0001`. Prefix required.
 * - `manual`        — the book generates nothing; the operator supplies the exact string.
 */
export type SequenceMode = 'numeric' | 'alphanumeric' | 'manual'

/**
 * The numeric counter inside a book.
 *
 * This is the ONLY numeric component of cheque numbering in the system. It is an
 * integer counter, manipulated with integer arithmetic only. It is never obtained by
 * parsing a complete cheque number, and it is never a floating-point value.
 */
export interface SequenceCounter {
  /** Sequence value of the first cheque in the book. Inclusive. */
  readonly startSequence: number
  /** Sequence value of the NEXT cheque to be issued. Advances by exactly 1 per issuance. */
  readonly currentSequence: number
  /** Inclusive upper bound, or `null` for an open-ended book. */
  readonly endSequence: number | null
}

/** Complete, immutable description of a book's numbering configuration. */
export interface ChequeBookSequenceState extends SequenceCounter {
  /** Fixed leading text, e.g. `"A"`. Empty for `numeric` mode. */
  readonly prefix: string
  readonly sequenceMode: SequenceMode
  /** Zero-padding width for the numeric component, or `null` for no padding. */
  readonly sequenceWidth: number | null
}

/** Input accepted when constructing a sequence; optional fields have safe defaults. */
export type ChequeBookSequenceInput = Partial<{
  prefix: string
  startSequence: number
  currentSequence: number
  endSequence: number | null
  sequenceMode: SequenceMode
  sequenceWidth: number | null
}>

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidChequeBookSequenceError(
      `${label} must be a safe integer, received ${String(value)}. ` +
        `Floating-point or out-of-range sequence values are not permitted.`
    )
  }
}

/**
 * Immutable cheque-number sequence engine.
 *
 * Pure and deterministic: every method either returns a value or returns a NEW state.
 * Nothing mutates in place, nothing reads a clock or a random source, and no global
 * counter exists anywhere — a sequence is always owned by exactly one cheque book.
 *
 * Supported progressions (see `__tests__/sequence-engine.test.ts`):
 *
 *     prefix=""   width=null  :  4567 -> 4568 -> 4569
 *     prefix="A"  width=null  :  A4567 -> A4568 -> A4569
 *     prefix="A"  width=4     :  A0001 -> A0002 -> A0003
 *     prefix=""   width=4     :  0001 -> 0002 -> 0003   (leading zeros preserved)
 */
export class ChequeBookSequence {
  readonly prefix: string
  readonly startSequence: number
  readonly currentSequence: number
  readonly endSequence: number | null
  readonly sequenceMode: SequenceMode
  readonly sequenceWidth: number | null

  private constructor(state: ChequeBookSequenceState) {
    this.prefix = state.prefix
    this.startSequence = state.startSequence
    this.currentSequence = state.currentSequence
    this.endSequence = state.endSequence
    this.sequenceMode = state.sequenceMode
    this.sequenceWidth = state.sequenceWidth
  }

  /**
   * Build and validate a sequence configuration.
   *
   * @throws InvalidChequeBookSequenceError on any inconsistent or non-integer input.
   */
  static create(input: ChequeBookSequenceInput = {}): ChequeBookSequence {
    const sequenceMode: SequenceMode = input.sequenceMode ?? 'numeric'

    if (
      sequenceMode !== 'numeric' &&
      sequenceMode !== 'alphanumeric' &&
      sequenceMode !== 'manual'
    ) {
      throw new InvalidChequeBookSequenceError(
        `sequenceMode must be one of "numeric" | "alphanumeric" | "manual", received "${String(sequenceMode)}"`
      )
    }

    const prefix = input.prefix ?? ''
    if (typeof prefix !== 'string') {
      throw new InvalidChequeBookSequenceError('prefix must be a string')
    }
    if (prefix.length > 0 && /\s/.test(prefix)) {
      throw new InvalidChequeBookSequenceError('prefix must not contain whitespace')
    }
    if (prefix.length > 16) {
      throw new InvalidChequeBookSequenceError('prefix must not exceed 16 characters')
    }

    // Mode/prefix coherence keeps the three modes meaningfully distinct and surfaces
    // misconfiguration at construction time rather than at print time.
    if (sequenceMode === 'numeric' && prefix.length > 0) {
      throw new InvalidChequeBookSequenceError(
        `sequenceMode "numeric" produces digits-only cheque numbers and cannot carry prefix "${prefix}". ` +
          `Use "alphanumeric" for a prefixed book.`
      )
    }
    if (sequenceMode === 'alphanumeric' && prefix.length === 0) {
      throw new InvalidChequeBookSequenceError(
        'sequenceMode "alphanumeric" requires a non-empty prefix. Use "numeric" for a digits-only book.'
      )
    }

    const sequenceWidth = input.sequenceWidth ?? null
    if (sequenceWidth !== null) {
      assertSafeInteger(sequenceWidth, 'sequenceWidth')
      if (sequenceWidth < 1 || sequenceWidth > ChequeNumber.MAX_LENGTH) {
        throw new InvalidChequeBookSequenceError(
          `sequenceWidth must be between 1 and ${ChequeNumber.MAX_LENGTH}, received ${sequenceWidth}`
        )
      }
    }

    const startSequence = input.startSequence ?? 1
    assertSafeInteger(startSequence, 'startSequence')
    if (startSequence < 0) {
      throw new InvalidChequeBookSequenceError(
        `startSequence must be >= 0, received ${startSequence}`
      )
    }

    const endSequence = input.endSequence ?? null
    if (endSequence !== null) {
      assertSafeInteger(endSequence, 'endSequence')
      if (endSequence < startSequence) {
        throw new InvalidChequeBookSequenceError(
          `endSequence (${endSequence}) must be >= startSequence (${startSequence})`
        )
      }
    }

    const currentSequence = input.currentSequence ?? startSequence
    assertSafeInteger(currentSequence, 'currentSequence')
    if (currentSequence < startSequence) {
      throw new InvalidChequeBookSequenceError(
        `currentSequence (${currentSequence}) must be >= startSequence (${startSequence}); ` +
          `a sequence cursor can never move backwards`
      )
    }

    return new ChequeBookSequence({
      prefix,
      startSequence,
      currentSequence,
      endSequence,
      sequenceMode,
      sequenceWidth,
    })
  }

  /** Whether this book generates its own numbers. */
  get isAutomatic(): boolean {
    return this.sequenceMode !== 'manual'
  }

  get isManual(): boolean {
    return this.sequenceMode === 'manual'
  }

  /**
   * True when no further number can be allocated.
   *
   * A manual book is never "exhausted" by the sequence, because it has no cursor to
   * advance; it is bounded only by the operator and by duplicate detection.
   */
  get isExhausted(): boolean {
    if (!this.isAutomatic) return false
    return this.endSequence !== null && this.currentSequence > this.endSequence
  }

  /**
   * Count of numbers still allocatable, or `null` when the book is open-ended or manual.
   * Computed with integer arithmetic.
   */
  get remaining(): number | null {
    if (!this.isAutomatic) return null
    if (this.endSequence === null) return null
    const left = this.endSequence - this.currentSequence + 1
    return left > 0 ? left : 0
  }

  /**
   * Format a sequence counter into a cheque number string.
   *
   * Pure and side-effect free. Zero padding is applied to the NUMERIC COMPONENT ONLY;
   * the prefix is never padded, and the width never truncates a longer value.
   *
   *     ("",  4567, null) -> "4567"
   *     ("A", 4567, null) -> "A4567"
   *     ("A", 1,    4)    -> "A0001"
   *     ("",  1,    4)    -> "0001"
   *     ("A", 12345, 4)   -> "A12345"
   */
  formatNumber(sequence: number): ChequeNumber {
    assertSafeInteger(sequence, 'sequence')
    if (sequence < 0) {
      throw new InvalidChequeBookSequenceError(`sequence must be >= 0, received ${sequence}`)
    }
    const digits =
      this.sequenceWidth === null
        ? String(sequence)
        : String(sequence).padStart(this.sequenceWidth, '0')
    return ChequeNumber.of(`${this.prefix}${digits}`)
  }

  /**
   * The next cheque number this book would issue — WITHOUT advancing the cursor.
   *
   * @throws ChequeBookExhaustedError when the book is spent.
   * @throws InvalidChequeBookSequenceError in `manual` mode, where there is nothing to peek.
   */
  peekNextChequeNumber(): ChequeNumber {
    if (!this.isAutomatic) {
      throw new InvalidChequeBookSequenceError(
        'cannot peek a next number on a "manual" book; the operator supplies each number'
      )
    }
    if (this.isExhausted) {
      throw new ChequeBookExhaustedError('(unbound sequence)', this.endSequence)
    }
    return this.formatNumber(this.currentSequence)
  }

  /**
   * Return the next cheque number AND a new sequence state with the cursor advanced by
   * exactly one. Integer arithmetic only; the receiver is never mutated.
   *
   * This is the single place in the codebase where a book's cursor moves forward, which
   * is what makes "cancelled numbers are never reused" structurally guaranteed: the
   * cursor only ever increases, so a consumed number can never be re-issued.
   *
   * @throws ChequeBookExhaustedError when the cursor has passed `endSequence`.
   * @throws InvalidChequeBookSequenceError in manual mode, or on cursor overflow.
   */
  allocate(chequeBookId: string): { chequeNumber: ChequeNumber; sequence: ChequeBookSequence } {
    if (!this.isAutomatic) {
      throw new InvalidChequeBookSequenceError(
        'cannot allocate from a "manual" book; the operator supplies each number'
      )
    }
    if (this.isExhausted) {
      throw new ChequeBookExhaustedError(chequeBookId, this.endSequence)
    }

    const chequeNumber = this.formatNumber(this.currentSequence)
    const nextCursor = this.currentSequence + 1

    if (!Number.isSafeInteger(nextCursor)) {
      throw new InvalidChequeBookSequenceError(
        `advancing the sequence from ${this.currentSequence} would exceed the safe integer range`
      )
    }

    const sequence = new ChequeBookSequence({
      prefix: this.prefix,
      startSequence: this.startSequence,
      currentSequence: nextCursor,
      endSequence: this.endSequence,
      sequenceMode: this.sequenceMode,
      sequenceWidth: this.sequenceWidth,
    })

    return { chequeNumber, sequence }
  }

  /**
   * Validate a manually supplied cheque number against this book's configuration.
   *
   * The number is NEVER parsed numerically. For a book with a configured prefix the
   * prefix is checked for an exact match so a mis-keyed number is caught early; beyond
   * that the value is accepted verbatim as an opaque string.
   *
   * @throws InvalidChequeBookSequenceError if the book is not in manual mode.
   * @throws InvalidChequeNumberError (propagated) if the string itself is unusable.
   */
  validateManualChequeNumber(raw: string): ChequeNumber {
    if (!this.isManual) {
      throw new InvalidChequeBookSequenceError(
        `a manual cheque number may only be supplied for a "manual" book, not "${this.sequenceMode}"`
      )
    }
    const chequeNumber = ChequeNumber.of(raw)

    if (this.prefix.length > 0 && !chequeNumber.value.startsWith(this.prefix)) {
      throw new InvalidChequeBookSequenceError(
        `manual cheque number "${chequeNumber.value}" does not start with the book's prefix "${this.prefix}"`
      )
    }
    return chequeNumber
  }

  toState(): ChequeBookSequenceState {
    return {
      prefix: this.prefix,
      startSequence: this.startSequence,
      currentSequence: this.currentSequence,
      endSequence: this.endSequence,
      sequenceMode: this.sequenceMode,
      sequenceWidth: this.sequenceWidth,
    }
  }

  toJSON(): ChequeBookSequenceState {
    return this.toState()
  }

  static fromJSON(state: ChequeBookSequenceInput): ChequeBookSequence {
    return ChequeBookSequence.create(state)
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Format a cheque number from its parts without constructing a full sequence.
 * Exposed for reporting and import tooling. Pure; integer arithmetic only.
 */
export function formatChequeNumber(
  prefix: string,
  sequence: number,
  sequenceWidth: number | null = null
): string {
  assertSafeInteger(sequence, 'sequence')
  return `${prefix}${sequenceWidth === null ? String(sequence) : String(sequence).padStart(sequenceWidth, '0')}`
}

/**
 * Recover the numeric sequence component from a cheque number, given a KNOWN prefix.
 *
 * This does NOT parse the complete cheque number. It strips a caller-supplied prefix
 * and interprets only the remaining digit string as the sequence counter. It exists
 * solely to seed a book's cursor from stock that is already partly used — for example
 * when migrating a legacy record or registering a physically pre-numbered book.
 *
 * It refuses anything ambiguous rather than guessing: the prefix must match exactly,
 * the remainder must be all ASCII digits, and it must fit the safe-integer range.
 *
 * @returns the integer sequence, or `null` when the number cannot be decomposed.
 */
export function decomposeSequence(chequeNumber: string, prefix: string): number | null {
  if (typeof chequeNumber !== 'string' || typeof prefix !== 'string') return null
  if (prefix.length > 0 && !chequeNumber.startsWith(prefix)) return null

  const remainder = chequeNumber.slice(prefix.length)
  if (remainder.length === 0) return null
  if (!/^[0-9]+$/.test(remainder)) return null

  // Guard the safe-integer range without ever going through a float.
  if (remainder.replace(/^0+/, '').length > 15) return null

  const sequence = Number.parseInt(remainder, 10)
  return Number.isSafeInteger(sequence) ? sequence : null
}
