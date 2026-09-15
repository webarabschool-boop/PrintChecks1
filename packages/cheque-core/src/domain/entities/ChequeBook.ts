import {
  ChequeBookExhaustedError,
  ChequeBookNotActiveError,
  DuplicateChequeNumberError,
  InvalidChequeBookSequenceError,
  RequiredFieldError,
  AggregateIntegrityError,
} from '../errors'
import {
  ChequeBookSequence,
  type ChequeBookSequenceInput,
  type ChequeBookSequenceState,
} from '../sequence/ChequeBookSequence'
import { ChequeNumber } from '../value-objects/ChequeNumber'
import type { IsoTimestamp } from './Bank'

/**
 * Physical state of a cheque book.
 *
 * `exhausted` is reached automatically when the sequence cursor passes `endSequence`.
 * `retired` / `lost` / `destroyed` are operator decisions; each permanently consumes every
 * remaining number, because a book that is not in your control must never be issued from.
 */
export type ChequeBookStatus = 'active' | 'exhausted' | 'retired' | 'lost' | 'destroyed'

export const CHEQUE_BOOK_STATUSES: readonly ChequeBookStatus[] = [
  'active',
  'exhausted',
  'retired',
  'lost',
  'destroyed',
] as const

export interface ChequeBookData {
  readonly id: string
  /** Owning account. Never optional — a book always belongs to a BankAccount. */
  readonly bankAccountId: string
  readonly label: string
  /** The bank's own stock/book reference, recorded verbatim when supplied. */
  readonly stockReference: string | null
  readonly sequence: ChequeBookSequenceState
  readonly status: ChequeBookStatus
  /**
   * Cheque numbers already consumed from this book, as exact strings.
   *
   * A physical book is bounded (typically tens to a few hundred leaves), so keeping the
   * consumed set inside the aggregate lets it enforce "no duplicates within this book"
   * on its own, independent of any repository. The repository enforces the same invariant
   * across persistence — defence in depth, not redundancy.
   */
  readonly reservedNumbers: readonly string[]
  /**
   * Optional reference to a physical layout template (Phase 3).
   *
   * Deliberately just an identifier: NO cheque dimensions, field coordinates or MICR
   * placement are modelled here, because those must come from real bank stock
   * specifications and must not be invented.
   */
  readonly templateId: string | null
  readonly receivedAt: IsoTimestamp | null
  readonly notes: string | null
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface CreateChequeBookInput {
  readonly id: string
  readonly bankAccountId: string
  readonly label: string
  readonly stockReference?: string | null
  readonly sequence?: ChequeBookSequenceInput
  readonly status?: ChequeBookStatus
  readonly reservedNumbers?: readonly string[]
  readonly templateId?: string | null
  readonly receivedAt?: IsoTimestamp | null
  readonly notes?: string | null
  readonly createdAt?: IsoTimestamp
  readonly updatedAt?: IsoTimestamp
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequiredFieldError(field)
  }
  return value.trim()
}

/**
 * ChequeBook — the aggregate root that OWNS cheque numbering.
 *
 * There is no global cheque-number counter anywhere in this system. Every number is
 * produced by exactly one book, so the same number may legitimately exist in two books
 * (even at two different banks) while being impossible to duplicate within one.
 *
 * Replaces the legacy global generator at
 * `packages/core/src/services/CheckService.ts:270-283`, which computed
 * `Math.max(...parseInt(checkNumber))` across ALL cheques and therefore could neither
 * support per-book sequences nor alphanumeric numbers such as `A4567`.
 */
export class ChequeBook {
  readonly id: string
  readonly bankAccountId: string
  readonly label: string
  readonly stockReference: string | null
  readonly status: ChequeBookStatus
  readonly templateId: string | null
  readonly receivedAt: IsoTimestamp | null
  readonly notes: string | null
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp

  private readonly _sequence: ChequeBookSequence
  private readonly _reserved: ReadonlySet<string>
  private readonly _reservedOrder: readonly string[]

  private constructor(data: ChequeBookData) {
    this.id = data.id
    this.bankAccountId = data.bankAccountId
    this.label = data.label
    this.stockReference = data.stockReference
    this.status = data.status
    this.templateId = data.templateId
    this.receivedAt = data.receivedAt
    this.notes = data.notes
    this.createdAt = data.createdAt
    this.updatedAt = data.updatedAt

    this._sequence = ChequeBookSequence.create(data.sequence)
    this._reservedOrder = Object.freeze([...data.reservedNumbers])
    this._reserved = new Set(this._reservedOrder)
  }

  static create(input: CreateChequeBookInput): ChequeBook {
    const now = input.createdAt ?? new Date().toISOString()

    const book = new ChequeBook({
      id: requireNonEmpty(input.id, 'ChequeBook.id'),
      bankAccountId: requireNonEmpty(input.bankAccountId, 'ChequeBook.bankAccountId'),
      label: requireNonEmpty(input.label, 'ChequeBook.label'),
      stockReference: input.stockReference ?? null,
      sequence: ChequeBookSequence.create(input.sequence ?? {}).toState(),
      status: input.status ?? 'active',
      reservedNumbers: input.reservedNumbers ?? [],
      templateId: input.templateId ?? null,
      receivedAt: input.receivedAt ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    })

    book.validate()
    return book
  }

  /** The immutable sequence configuration/state owned by this book. */
  get sequence(): ChequeBookSequence {
    return this._sequence
  }

  /** Exact strings of every number consumed from this book, in consumption order. */
  get reservedNumbers(): readonly string[] {
    return this._reservedOrder
  }

  get isAutomatic(): boolean {
    return this._sequence.isAutomatic
  }

  get isManual(): boolean {
    return this._sequence.isManual
  }

  /** True when the book cannot issue any further cheque. */
  get isIssuable(): boolean {
    if (this.status !== 'active') return false
    return !this._sequence.isExhausted
  }

  get remaining(): number | null {
    return this._sequence.remaining
  }

  /** Whether this exact number has already been consumed from this book. */
  hasReserved(chequeNumber: ChequeNumber | string): boolean {
    const value = typeof chequeNumber === 'string' ? chequeNumber : chequeNumber.value
    return this._reserved.has(value)
  }

  /**
   * The next number this book would issue, without consuming it.
   *
   * @throws ChequeBookNotActiveError if the book is not active.
   * @throws ChequeBookExhaustedError if the sequence is spent.
   * @throws InvalidChequeBookSequenceError for a manual book.
   */
  peekNextChequeNumber(): ChequeNumber {
    this.assertIssuable()
    return this._sequence.peekNextChequeNumber()
  }

  /**
   * Consume the next automatic number and return a NEW book with the cursor advanced.
   *
   * The returned book is the one that must be persisted. Because the cursor only ever
   * increases and the consumed number is recorded in `reservedNumbers`, a number can never
   * be re-issued — including after the cheque that used it is cancelled, voided or spoiled.
   *
   * @throws ChequeBookNotActiveError · ChequeBookExhaustedError · DuplicateChequeNumberError
   */
  allocateNextChequeNumber(updatedAt: IsoTimestamp): {
    chequeNumber: ChequeNumber
    book: ChequeBook
  } {
    this.assertIssuable()

    const { chequeNumber, sequence } = this._sequence.allocate(this.id)

    // Should be unreachable for a well-formed automatic book (the cursor never repeats),
    // but asserted anyway so a corrupted cursor cannot silently mint a duplicate.
    if (this._reserved.has(chequeNumber.value)) {
      throw new DuplicateChequeNumberError(this.id, chequeNumber.value)
    }

    const book = this.withSequenceAndReservation(sequence, chequeNumber, updatedAt)

    // Reaching the inclusive end sequence retires the book automatically: this is the
    // defined end-of-book behaviour.
    const finalStatus: ChequeBookStatus = sequence.isExhausted ? 'exhausted' : book.status

    return {
      chequeNumber,
      book: finalStatus === book.status ? book : book.withStatus(finalStatus, updatedAt),
    }
  }

  /**
   * Consume an operator-supplied number on a `manual` book.
   *
   * The value is validated as an opaque string and is NEVER parsed numerically.
   *
   * @throws ChequeBookNotActiveError · ManualNumberRequiredError (via mode check) ·
   *         DuplicateChequeNumberError
   */
  reserveManualChequeNumber(
    rawChequeNumber: string,
    updatedAt: IsoTimestamp
  ): { chequeNumber: ChequeNumber; book: ChequeBook } {
    this.assertIssuable()

    if (!this.isManual) {
      throw new InvalidChequeBookSequenceError(
        `cheque book "${this.id}" uses "${this._sequence.sequenceMode}" numbering; ` +
          `numbers are generated automatically and must not be supplied manually`
      )
    }

    const chequeNumber = this._sequence.validateManualChequeNumber(rawChequeNumber)

    if (this._reserved.has(chequeNumber.value)) {
      throw new DuplicateChequeNumberError(this.id, chequeNumber.value)
    }

    return {
      chequeNumber,
      book: this.withSequenceAndReservation(this._sequence, chequeNumber, updatedAt),
    }
  }

  /** Mark the book retired; all remaining numbers are permanently consumed. */
  retire(updatedAt: IsoTimestamp): ChequeBook {
    return this.withStatus('retired', updatedAt)
  }

  /** Report the physical book as lost. Irreversible. */
  reportLost(updatedAt: IsoTimestamp): ChequeBook {
    return this.withStatus('lost', updatedAt)
  }

  /** Report the physical book as destroyed (e.g. spoiled stock). Irreversible. */
  reportDestroyed(updatedAt: IsoTimestamp): ChequeBook {
    return this.withStatus('destroyed', updatedAt)
  }

  /**
   * Return an `exhausted` or `retired` book to `active`.
   *
   * A lost or destroyed book can never be reactivated: its physical leaves are outside
   * the organisation's control.
   */
  reactivate(updatedAt: IsoTimestamp): ChequeBook {
    if (this.status === 'lost' || this.status === 'destroyed') {
      throw new ChequeBookNotActiveError(
        this.id,
        `${this.status} (a ${this.status} book can never be reactivated)`
      )
    }
    if (this._sequence.isExhausted) {
      throw new ChequeBookExhaustedError(this.id, this._sequence.endSequence)
    }
    return this.withStatus('active', updatedAt)
  }

  withStatus(status: ChequeBookStatus, updatedAt: IsoTimestamp): ChequeBook {
    if (!(CHEQUE_BOOK_STATUSES as readonly string[]).includes(status)) {
      throw new AggregateIntegrityError(`unknown ChequeBook status "${String(status)}"`)
    }
    return new ChequeBook({ ...this.toData(), status, updatedAt })
  }

  private withSequenceAndReservation(
    sequence: ChequeBookSequence,
    chequeNumber: ChequeNumber,
    updatedAt: IsoTimestamp
  ): ChequeBook {
    return new ChequeBook({
      ...this.toData(),
      sequence: sequence.toState(),
      reservedNumbers: [...this._reservedOrder, chequeNumber.value],
      updatedAt,
    })
  }

  private assertIssuable(): void {
    // Exhaustion is checked first: an exhausted book also has status "exhausted", and
    // ChequeBookExhaustedError is the more actionable diagnosis (open the next book) than
    // the generic not-active error.
    if (this._sequence.isExhausted) {
      throw new ChequeBookExhaustedError(this.id, this._sequence.endSequence)
    }
    if (this.status !== 'active') {
      throw new ChequeBookNotActiveError(this.id, this.status)
    }
  }

  validate(): void {
    if (this.id.trim().length === 0) throw new RequiredFieldError('ChequeBook.id')
    if (this.bankAccountId.trim().length === 0) {
      throw new AggregateIntegrityError(
        'ChequeBook.bankAccountId is required; a book must belong to a BankAccount'
      )
    }
    if (this.label.trim().length === 0) throw new RequiredFieldError('ChequeBook.label')

    // The sequence constructor re-validates its own invariants.
    ChequeBookSequence.create(this._sequence.toState())

    for (const reserved of this._reservedOrder) {
      // Re-validate as opaque strings; never parsed numerically.
      ChequeNumber.of(reserved)
    }

    const duplicates = this._reservedOrder.length !== this._reserved.size
    if (duplicates) {
      throw new AggregateIntegrityError(
        `ChequeBook "${this.id}" has duplicate entries in reservedNumbers`
      )
    }

    // Every reserved number must be consistent with the book's prefix, so a book cannot
    // accumulate numbers that could not have come from it.
    const prefix = this._sequence.prefix
    if (prefix.length > 0) {
      for (const reserved of this._reservedOrder) {
        if (!reserved.startsWith(prefix)) {
          throw new AggregateIntegrityError(
            `reserved cheque number "${reserved}" does not match book prefix "${prefix}"`
          )
        }
      }
    }

  }

  toData(): ChequeBookData {
    return {
      id: this.id,
      bankAccountId: this.bankAccountId,
      label: this.label,
      stockReference: this.stockReference,
      sequence: this._sequence.toState(),
      status: this.status,
      reservedNumbers: this._reservedOrder,
      templateId: this.templateId,
      receivedAt: this.receivedAt,
      notes: this.notes,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }

  toJSON(): ChequeBookData {
    return this.toData()
  }

  static fromJSON(data: ChequeBookData): ChequeBook {
    const book = new ChequeBook({
      ...data,
      stockReference: data.stockReference ?? null,
      templateId: data.templateId ?? null,
      receivedAt: data.receivedAt ?? null,
      notes: data.notes ?? null,
      reservedNumbers: data.reservedNumbers ?? [],
    })
    book.validate()
    return book
  }
}
