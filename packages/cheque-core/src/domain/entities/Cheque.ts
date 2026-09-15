import { AggregateIntegrityError, InvalidChequeStatusTransitionError, RequiredFieldError } from '../errors'
import {
  allowedTransitions,
  appendStatusEntry,
  assertTransition,
  isChequeStatus,
  isTerminalStatus,
  statusFromHistory,
  type ChequeStatus,
  type ChequeStatusEntry,
} from '../lifecycle/ChequeStatus'
import { ChequeNumber } from '../value-objects/ChequeNumber'
import { Money, type MoneyJson } from '../value-objects/Money'
import type { IsoTimestamp } from './Bank'

/**
 * Cheques the organisation WRITES (drawn on its own account, from its own cheque book)
 * versus cheques it RECEIVES (drawn by someone else, deposited by the organisation).
 *
 * A single entity with a discriminator — rather than two parallel hierarchies — keeps the
 * lifecycle, Money and cheque-number rules in one place.
 */
export type ChequeDirection = 'outgoing' | 'incoming'

export const CHEQUE_DIRECTIONS: readonly ChequeDirection[] = ['outgoing', 'incoming'] as const

export interface ChequeData {
  readonly id: string
  readonly direction: ChequeDirection
  /**
   * Owning cheque book.
   *
   * REQUIRED for `outgoing` cheques — a written cheque always comes from a book, and that
   * book is what owns its number. Must be `null` for `incoming` cheques, whose numbers
   * belong to somebody else's book.
   */
  readonly chequeBookId: string | null
  /** Denormalised for query convenience; derived from the book at issuance time. */
  readonly bankAccountId: string | null
  /**
   * The cheque number as an EXACT STRING.
   *
   * Never a numeric field, never parsed numerically, never normalised. Leading zeros and
   * alphabetic prefixes are significant and survive display, search, reporting, printing,
   * import/export and audit.
   */
  readonly chequeNumber: string
  /** Date written on the cheque (ISO-8601). Distinct from `createdAt`. */
  readonly chequeDate: string
  readonly amount: MoneyJson
  readonly payeeName: string
  /** Drawer of an incoming cheque; for outgoing cheques this is the account holder. */
  readonly drawerName: string | null
  /**
   * Free text exactly as it appears on an incoming cheque.
   *
   * Deliberately NOT resolved to a `bankId`: an incoming cheque is a record of what was
   * received, and the issuing institution may not exist in this system.
   */
  readonly issuingBankName: string | null
  readonly memo: string | null
  readonly reference: string | null
  /**
   * Append-only lifecycle history.
   *
   * `status` is DERIVED from this array, never stored separately, so a state change
   * without a history entry is impossible and history cannot be added later by rewriting
   * the entity.
   */
  readonly statusHistory: readonly ChequeStatusEntry[]
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly createdBy: string | null
}

export interface CreateChequeInput {
  readonly id: string
  readonly direction?: ChequeDirection
  readonly chequeBookId?: string | null
  readonly bankAccountId?: string | null
  readonly chequeNumber: string
  readonly chequeDate?: string
  readonly amount: Money
  readonly payeeName: string
  readonly drawerName?: string | null
  readonly issuingBankName?: string | null
  readonly memo?: string | null
  readonly reference?: string | null
  readonly initialStatus?: ChequeStatus
  readonly createdAt?: IsoTimestamp
  readonly updatedAt?: IsoTimestamp
  readonly createdBy?: string | null
}

export interface TransitionMeta {
  readonly occurredAt: IsoTimestamp
  readonly reason?: string
  readonly actorId?: string
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RequiredFieldError(field)
  }
  return value.trim()
}

/**
 * Cheque — belongs to a {@link ChequeBook}, which belongs to a {@link BankAccount},
 * which belongs to a {@link Bank}.
 *
 * Replaces the legacy `Check` entity (`packages/core/src/models/Check.ts`) whose
 * `checkNumber` was a `string | number`, whose `amount` was a `string | number`, whose
 * bank identity was a free-text `bankName`, and whose `status` was a plain mutable field.
 */
export class Cheque {
  readonly id: string
  readonly direction: ChequeDirection
  readonly chequeBookId: string | null
  readonly bankAccountId: string | null
  readonly chequeDate: string
  readonly payeeName: string
  readonly drawerName: string | null
  readonly issuingBankName: string | null
  readonly memo: string | null
  readonly reference: string | null
  readonly statusHistory: readonly ChequeStatusEntry[]
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly createdBy: string | null

  private readonly _chequeNumber: ChequeNumber
  private readonly _amount: Money

  private constructor(data: ChequeData) {
    this.id = data.id
    this.direction = data.direction
    this.chequeBookId = data.chequeBookId
    this.bankAccountId = data.bankAccountId
    this.chequeDate = data.chequeDate
    this.payeeName = data.payeeName
    this.drawerName = data.drawerName
    this.issuingBankName = data.issuingBankName
    this.memo = data.memo
    this.reference = data.reference
    this.statusHistory = Object.freeze([...data.statusHistory])
    this.createdAt = data.createdAt
    this.updatedAt = data.updatedAt
    this.createdBy = data.createdBy

    this._chequeNumber = ChequeNumber.of(data.chequeNumber)
    this._amount = Money.fromJSON(data.amount)
  }

  static create(input: CreateChequeInput): Cheque {
    const now = input.createdAt ?? new Date().toISOString()
    const direction: ChequeDirection = input.direction ?? 'outgoing'

    if (direction !== 'outgoing' && direction !== 'incoming') {
      throw new AggregateIntegrityError(
        `Cheque.direction must be "outgoing" or "incoming", received "${String(direction)}"`
      )
    }

    if (!(input.amount instanceof Money)) {
      throw new AggregateIntegrityError(
        'Cheque.amount must be an instance of the Money value object, not a raw number or string. ' +
          'Use Money.fromDecimalString("1234.56", "EGP") or Money.fromMinorUnits(123456, "EGP").'
      )
    }

    const chequeBookId = input.chequeBookId ?? null
    if (direction === 'outgoing' && (chequeBookId === null || chequeBookId.trim().length === 0)) {
      throw new AggregateIntegrityError(
        'An outgoing cheque must belong to a ChequeBook: the book owns its number and its sequence.'
      )
    }
    if (direction === 'incoming' && chequeBookId !== null) {
      throw new AggregateIntegrityError(
        'An incoming cheque must not reference a ChequeBook; its number belongs to another party.'
      )
    }

    const initialStatus: ChequeStatus = input.initialStatus ?? 'draft'
    if (!isChequeStatus(initialStatus)) {
      throw new AggregateIntegrityError(`unknown cheque status "${String(initialStatus)}"`)
    }

    const cheque = new Cheque({
      id: requireNonEmpty(input.id, 'Cheque.id'),
      direction,
      chequeBookId,
      bankAccountId: input.bankAccountId ?? null,
      chequeNumber: input.chequeNumber,
      chequeDate: input.chequeDate ?? now.slice(0, 10),
      amount: input.amount.toJSON(),
      payeeName: requireNonEmpty(input.payeeName, 'Cheque.payeeName'),
      drawerName: input.drawerName ?? null,
      issuingBankName: input.issuingBankName ?? null,
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      statusHistory: [{ from: null, to: initialStatus, occurredAt: now }],
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
      createdBy: input.createdBy ?? null,
    })

    cheque.validate()
    return cheque
  }

  /** The cheque number as a value object. Its `.value` is the exact persisted string. */
  get chequeNumber(): ChequeNumber {
    return this._chequeNumber
  }

  /** The exact cheque number string. Convenience accessor for printing and reporting. */
  get chequeNumberValue(): string {
    return this._chequeNumber.value
  }

  /** Exact monetary amount. Never a float. */
  get amount(): Money {
    return this._amount
  }

  /** Derived from the append-only history — there is no separately stored status field. */
  get status(): ChequeStatus {
    const derived = statusFromHistory(this.statusHistory)
    if (derived === null) {
      // Unreachable for a constructed Cheque; guarded so the type stays non-nullable.
      throw new AggregateIntegrityError(`Cheque "${this.id}" has an empty status history`)
    }
    return derived
  }

  /** Whether the cheque has reached a state from which it cannot move. */
  isTerminal(): boolean {
    return isTerminalStatus(this.status)
  }

  /** Statuses this cheque may move to from its current state. */
  allowedTransitions(): readonly ChequeStatus[] {
    return allowedTransitions(this.status)
  }

  canTransitionTo(status: ChequeStatus): boolean {
    return this.allowedTransitions().includes(status)
  }

  /**
   * Apply a lifecycle transition, returning a NEW cheque with the history appended.
   *
   * Transitions are validated against the single table in `lifecycle/ChequeStatus.ts`;
   * arbitrary status assignment is not possible. Because the history is append-only, a
   * cancelled or returned cheque retains a complete audit trail and its number is never
   * released for reuse.
   *
   * @throws InvalidChequeStatusTransitionError when the transition is not permitted.
   */
  transitionTo(status: ChequeStatus, meta: TransitionMeta): Cheque {
    if (!isChequeStatus(status)) {
      throw new AggregateIntegrityError(`unknown cheque status "${String(status)}"`)
    }

    const from = this.status
    assertTransition(from, status)

    const entry: ChequeStatusEntry = {
      from,
      to: status,
      occurredAt: meta.occurredAt,
      reason: meta.reason,
      actorId: meta.actorId,
    }

    const cheque = new Cheque({
      ...this.toData(),
      statusHistory: appendStatusEntry(this.statusHistory, entry),
      updatedAt: meta.occurredAt,
    })
    cheque.validate()
    return cheque
  }

  /**
   * Correct payee / memo / reference / date BEFORE the cheque leaves the system.
   *
   * Restricted to `draft`: once a cheque is issued its printed content is fixed, so any
   * change must go through cancellation and re-issuance (which consumes a new number)
   * rather than silently editing an audited financial document.
   *
   * The cheque number and the amount are intentionally NOT editable through this method.
   *
   * @throws InvalidChequeStatusTransitionError when the cheque is no longer a draft.
   */
  withCorrections(
    corrections: Partial<Pick<ChequeData, 'payeeName' | 'memo' | 'reference' | 'chequeDate'>>,
    updatedAt: IsoTimestamp
  ): Cheque {
    if (this.status !== 'draft') {
      throw new InvalidChequeStatusTransitionError(this.status, 'draft', [
        'a cheque can only be corrected while it is still a draft',
      ])
    }
    const cheque = new Cheque({ ...this.toData(), ...corrections, updatedAt })
    cheque.validate()
    return cheque
  }

  validate(): void {
    if (this.id.trim().length === 0) throw new RequiredFieldError('Cheque.id')
    if (this.payeeName.trim().length === 0) throw new RequiredFieldError('Cheque.payeeName')

    // ChequeNumber.of already enforced the string rules; re-run so validate() is total.
    ChequeNumber.of(this._chequeNumber.value)

    if (
      this.direction === 'outgoing' &&
      (this.chequeBookId === null || this.chequeBookId.length === 0)
    ) {
      throw new AggregateIntegrityError(`outgoing cheque "${this.id}" must reference a ChequeBook`)
    }
    if (this.direction === 'incoming' && this.chequeBookId !== null) {
      throw new AggregateIntegrityError(`incoming cheque "${this.id}" must not reference a ChequeBook`)
    }

    if (this.statusHistory.length === 0) {
      throw new AggregateIntegrityError(`cheque "${this.id}" has no status history`)
    }

    // The history must form a legal chain: each entry's `from` equals the previous `to`.
    // This is what makes the history authoritative rather than decorative.
    let previous: ChequeStatus | null = null
    for (const entry of this.statusHistory) {
      if (entry.from !== previous) {
        throw new AggregateIntegrityError(
          `cheque "${this.id}" has a broken status history: expected a transition from ` +
            `"${previous ?? 'null'}" but found "${entry.from ?? 'null'}" -> "${entry.to}"`
        )
      }
      previous = entry.to
    }

    if (!/^\d{4}-\d{2}-\d{2}/.test(this.chequeDate)) {
      throw new AggregateIntegrityError(
        `cheque "${this.id}" has a non-ISO chequeDate "${this.chequeDate}"`
      )
    }
  }

  toData(): ChequeData {
    return {
      id: this.id,
      direction: this.direction,
      chequeBookId: this.chequeBookId,
      bankAccountId: this.bankAccountId,
      chequeNumber: this._chequeNumber.value,
      chequeDate: this.chequeDate,
      amount: this._amount.toJSON(),
      payeeName: this.payeeName,
      drawerName: this.drawerName,
      issuingBankName: this.issuingBankName,
      memo: this.memo,
      reference: this.reference,
      statusHistory: this.statusHistory,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      createdBy: this.createdBy,
    }
  }

  toJSON(): ChequeData {
    return this.toData()
  }

  static fromJSON(data: ChequeData): Cheque {
    const cheque = new Cheque({
      ...data,
      chequeBookId: data.chequeBookId ?? null,
      bankAccountId: data.bankAccountId ?? null,
      drawerName: data.drawerName ?? null,
      issuingBankName: data.issuingBankName ?? null,
      memo: data.memo ?? null,
      reference: data.reference ?? null,
      createdBy: data.createdBy ?? null,
      statusHistory: data.statusHistory ?? [],
    })
    cheque.validate()
    return cheque
  }
}
