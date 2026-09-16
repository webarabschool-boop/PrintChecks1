/**
 * Typed domain errors.
 *
 * Every failure the domain can raise is represented here as a distinct class so that
 * callers can branch on error identity instead of parsing message strings. This is a
 * deliberate replacement for the legacy pattern of `throw new Error('... string ...')`
 * found throughout `packages/core/src/services`.
 */

/** Base class for every error raised by the cheque domain. */
export abstract class ChequeDomainError extends Error {
  /** Stable machine-readable discriminator, safe to switch on and to persist. */
  abstract readonly code: string

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

// ---------------------------------------------------------------------------
// Identifiers / validation
// ---------------------------------------------------------------------------

export class InvalidChequeNumberError extends ChequeDomainError {
  readonly code = 'CHEQUE_NUMBER_INVALID'
  constructor(
    public readonly reason: string,
    public readonly attemptedValue?: string
  ) {
    super(`Invalid cheque number: ${reason}`)
  }
}

export class InvalidMoneyError extends ChequeDomainError {
  readonly code = 'MONEY_INVALID'
  constructor(public readonly reason: string) {
    super(`Invalid money value: ${reason}`)
  }
}

export class CurrencyMismatchError extends ChequeDomainError {
  readonly code = 'CURRENCY_MISMATCH'
  constructor(
    public readonly left: string,
    public readonly right: string
  ) {
    super(`Cannot combine amounts in different currencies: ${left} vs ${right}`)
  }
}

export class UnknownCurrencyError extends ChequeDomainError {
  readonly code = 'CURRENCY_UNKNOWN'
  constructor(public readonly currency: string) {
    super(
      `Unknown currency "${currency}". Expected a 3-letter ISO 4217 code; if the code is ` +
        `valid, register its minor-digit count on the CurrencyRegistry or pass minorDigits ` +
        `explicitly.`
    )
  }
}

export class MoneyOverflowError extends ChequeDomainError {
  readonly code = 'MONEY_OVERFLOW'
  constructor(public readonly reason: string) {
    super(`Monetary value out of safe integer range: ${reason}`)
  }
}

export class RequiredFieldError extends ChequeDomainError {
  readonly code = 'FIELD_REQUIRED'
  constructor(public readonly field: string) {
    super(`Required field is missing or empty: ${field}`)
  }
}

// ---------------------------------------------------------------------------
// Cheque book / sequence
// ---------------------------------------------------------------------------

export class InvalidChequeBookSequenceError extends ChequeDomainError {
  readonly code = 'CHEQUE_BOOK_SEQUENCE_INVALID'
  constructor(public readonly reason: string) {
    super(`Invalid cheque book sequence configuration: ${reason}`)
  }
}

/**
 * Raised when a book has no further numbers to allocate.
 *
 * This is the defined end-of-book behaviour: the book becomes `exhausted` and
 * allocation fails loudly rather than silently wrapping or reusing a number.
 */
export class ChequeBookExhaustedError extends ChequeDomainError {
  readonly code = 'CHEQUE_BOOK_EXHAUSTED'
  constructor(
    public readonly chequeBookId: string,
    public readonly endSequence: number | null
  ) {
    super(
      `Cheque book "${chequeBookId}" has no remaining numbers` +
        (endSequence === null ? '.' : ` (end sequence ${endSequence} reached).`)
    )
  }
}

export class ChequeBookNotActiveError extends ChequeDomainError {
  readonly code = 'CHEQUE_BOOK_NOT_ACTIVE'
  constructor(
    public readonly chequeBookId: string,
    public readonly status: string
  ) {
    super(`Cheque book "${chequeBookId}" is not active (status: ${status}).`)
  }
}

export class ManualNumberRequiredError extends ChequeDomainError {
  readonly code = 'MANUAL_NUMBER_REQUIRED'
  constructor(public readonly chequeBookId: string) {
    super(
      `Cheque book "${chequeBookId}" uses manual numbering; an explicit chequeNumber string must be supplied.`
    )
  }
}

export class AutomaticNumberNotPermittedError extends ChequeDomainError {
  readonly code = 'AUTOMATIC_NUMBER_NOT_PERMITTED'
  constructor(
    public readonly chequeBookId: string,
    public readonly sequenceMode: string
  ) {
    super(
      `Cheque book "${chequeBookId}" uses "${sequenceMode}" numbering; ` +
        `a cheque number must not be supplied manually.`
    )
  }
}

/**
 * Raised when the same cheque number is used twice inside the SAME cheque book.
 *
 * Note this is scoped to a book: the identical number in a different book is legal
 * and must never raise this error.
 */
export class DuplicateChequeNumberError extends ChequeDomainError {
  readonly code = 'DUPLICATE_CHEQUE_NUMBER'
  constructor(
    public readonly chequeBookId: string,
    public readonly chequeNumber: string
  ) {
    super(`Cheque number "${chequeNumber}" already exists in cheque book "${chequeBookId}".`)
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export class InvalidChequeStatusTransitionError extends ChequeDomainError {
  readonly code = 'CHEQUE_STATUS_TRANSITION_INVALID'
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly allowed: readonly string[]
  ) {
    super(
      `Illegal cheque status transition "${from}" -> "${to}". ` +
        `Allowed from "${from}": ${allowed.length > 0 ? allowed.join(', ') : '(none - terminal state)'}.`
    )
  }
}

// ---------------------------------------------------------------------------
// Aggregate / reference integrity
// ---------------------------------------------------------------------------

export class EntityNotFoundError extends ChequeDomainError {
  readonly code = 'ENTITY_NOT_FOUND'
  constructor(
    public readonly entityType: string,
    public readonly id: string
  ) {
    super(`${entityType} with id "${id}" was not found.`)
  }
}

export class InactiveEntityError extends ChequeDomainError {
  readonly code = 'ENTITY_INACTIVE'
  constructor(
    public readonly entityType: string,
    public readonly id: string
  ) {
    super(`${entityType} "${id}" is not active.`)
  }
}

export class AggregateIntegrityError extends ChequeDomainError {
  readonly code = 'AGGREGATE_INTEGRITY'
  constructor(public readonly reason: string) {
    super(`Aggregate integrity violation: ${reason}`)
  }
}
