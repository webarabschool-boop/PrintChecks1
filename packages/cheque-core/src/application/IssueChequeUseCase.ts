import type { Cheque, ChequeBook } from '../domain/entities/index'
import { Cheque as ChequeEntity } from '../domain/entities/Cheque'
import type { ChequeStatus } from '../domain/lifecycle/ChequeStatus'
import type { ChequeNumber } from '../domain/value-objects/ChequeNumber'
import { Money } from '../domain/value-objects/Money'
import {
  AutomaticNumberNotPermittedError,
  ChequeBookExhaustedError,
  ChequeBookNotActiveError,
  DuplicateChequeNumberError,
  EntityNotFoundError,
  InactiveEntityError,
  ManualNumberRequiredError,
} from '../domain/errors'
import type { Clock } from '../ports/Clock'
import type { IdGenerator } from '../ports/IdGenerator'
import type {
  TransactionGuarantee,
  UnitOfWork,
  UnitOfWorkFactory,
} from '../ports/repositories'

/**
 * What the caller supplies to issue a cheque.
 *
 * Note what is NOT here: no issuance without a `chequeBookId`, no free-text bank name, no
 * `chequeNumber` for the caller to invent (except on a `manual` book), and no raw `number`
 * amount.
 */
export interface IssueChequeInput {
  /** The book to draw from. It owns the number. */
  readonly chequeBookId: string
  readonly payeeName: string
  readonly amount: Money
  /** Date printed on the cheque. Defaults to today, via the injected Clock. */
  readonly chequeDate?: string
  readonly memo?: string | null
  readonly reference?: string | null
  readonly drawerName?: string | null
  /**
   * Required for a `manual` book; FORBIDDEN for an automatic one.
   *
   * Accepted verbatim as an opaque string and never parsed numerically.
   */
  readonly chequeNumber?: string | null
  /** Defaults to `issued`. A caller may create a `draft` instead. */
  readonly initialStatus?: ChequeStatus
  readonly actorId?: string | null
}

export interface IssueChequeResult {
  readonly cheque: Cheque
  /** The book AFTER the sequence advanced — already persisted when this returns. */
  readonly chequeBook: ChequeBook
  /** The exact cheque number string. */
  readonly chequeNumber: string
  readonly bankAccountId: string
  readonly bankId: string
  /** The atomicity level this write actually ran under. See {@link TRANSACTIONALITY}. */
  readonly transactionGuarantee: TransactionGuarantee
}

export interface IssueChequeUseCaseOptions {
  readonly unitOfWorkFactory: UnitOfWorkFactory
  readonly idGenerator: IdGenerator
  readonly clock: Clock
  /** Override for tests; defaults to `issued`. */
  readonly defaultInitialStatus?: ChequeStatus
}

/**
 * Documented transactional behaviour of cheque issuance.
 *
 * Exported so an adapter, a diagnostics screen or the documentation can state the
 * guarantee precisely instead of leaving it implicit.
 */
export const TRANSACTIONALITY = {
  /**
   * With an `atomic` backend (SQL, IndexedDB) the sequence advance and the cheque write
   * commit together. If anything fails, NEITHER happens: the number is not consumed and
   * remains available to the next successful issuance.
   */
  atomic:
    'Cheque creation and cheque-book sequence advance are committed in a single transaction. ' +
    'A failure rolls both back, so a failed issuance consumes no number.',

  /**
   * `localStorage` has no transactions. A single `setItem` cannot partially apply, but a
   * failure BETWEEN two keys (cheque written, book not advanced — or the reverse) is
   * possible when storage is full, disabled or throws.
   *
   * The use case therefore fails CLOSED: it writes both records in one scope, and on any
   * failure rolls back what it can and rethrows. The residual window is small but real,
   * which is why a deployment that must never risk a partial write should use an adapter
   * reporting `atomic`. Numbers are never re-issued by this code path regardless: the
   * sequence cursor only ever increases.
   */
  bestEffort:
    'localStorage offers no transactions. The cheque and the advanced book are written in one ' +
    'scope and rolled back together on failure, but a crash between the two writes can leave ' +
    'partial state. The sequence cursor never moves backwards, so a consumed number is never ' +
    're-issued even in that case.',

  none: 'Adapter reports no transactional support; each write is applied independently.',
} as const

/**
 * Issue a cheque from a cheque book — atomically.
 *
 * This is the single sanctioned way to consume a cheque number. It replaces
 * `CheckService.getNextCheckNumber()` (`packages/core/src/services/CheckService.ts:270-283`),
 * which scanned every cheque in the system with `Math.max(...parseInt(checkNumber))` and
 * wrote the new record separately — a design that could neither scope numbers to a book,
 * nor handle `A4567`, nor avoid the "number consumed, write failed" hazard.
 *
 * ## Order of operations
 *
 *  1. Resolve and validate the cheque book, its bank account and its bank. Every failure
 *     here happens BEFORE a number is touched, so a rejected request consumes nothing.
 *  2. Open a unit of work.
 *  3. Obtain the number: `allocateNextChequeNumber()` for an automatic book (which returns
 *     the advanced sequence), or validate the caller-supplied string for a `manual` book.
 *  4. Re-check the number against the repository — defence in depth against a concurrent
 *     writer or a stale in-memory book.
 *  5. Construct the `Cheque` entity, which validates its own invariants.
 *  6. Persist the cheque AND the advanced book inside the same unit of work.
 *  7. Commit.
 *
 * On any error the unit of work is rolled back and the error is rethrown. Failures are
 * never swallowed and never reported as success.
 */
export class IssueChequeUseCase {
  private readonly unitOfWorkFactory: UnitOfWorkFactory
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly defaultInitialStatus: ChequeStatus

  constructor(options: IssueChequeUseCaseOptions) {
    this.unitOfWorkFactory = options.unitOfWorkFactory
    this.idGenerator = options.idGenerator
    this.clock = options.clock
    this.defaultInitialStatus = options.defaultInitialStatus ?? 'issued'
  }

  /** The atomicity level this use case will run under, before any work is done. */
  get transactionGuarantee(): TransactionGuarantee {
    return this.unitOfWorkFactory.capabilities.guarantee
  }

  async execute(input: IssueChequeInput): Promise<IssueChequeResult> {
    const unitOfWork = await this.unitOfWorkFactory.begin()
    let committed = false

    try {
      // ---- Step 1: context resolution and validation, before any number is consumed.
      const context = await this.resolveContext(unitOfWork, input.chequeBookId)

      // ---- Step 3: obtain the number from the book that owns it.
      const now = this.clock.now()
      const { chequeNumber, chequeBook } = this.obtainChequeNumber(context.book, input, now)

      // ---- Step 4: duplicate guard across persistence, not just in memory.
      await this.assertNumberIsFree(unitOfWork, chequeNumber, context.book.id)

      // ---- Step 5: construct the entity.
      const cheque = ChequeEntity.create({
        id: this.idGenerator.next('cheque'),
        direction: 'outgoing',
        chequeBookId: context.book.id,
        bankAccountId: context.bankAccountId,
        chequeNumber: chequeNumber.value,
        chequeDate: input.chequeDate,
        amount: input.amount,
        payeeName: input.payeeName,
        drawerName: input.drawerName ?? null,
        // An outgoing cheque is drawn on our own account, so there is no external issuer.
        issuingBankName: null,
        memo: input.memo ?? null,
        reference: input.reference ?? null,
        initialStatus: input.initialStatus ?? this.defaultInitialStatus,
        createdAt: now,
        createdBy: input.actorId ?? null,
      })

      // ---- Step 6: persist both records inside the same scope.
      await unitOfWork.cheques.save(cheque)
      await unitOfWork.chequeBooks.save(chequeBook)

      // ---- Step 7: commit.
      await unitOfWork.commit()
      committed = true

      return {
        cheque,
        chequeBook,
        chequeNumber: chequeNumber.value,
        bankAccountId: context.bankAccountId,
        bankId: context.bankId,
        transactionGuarantee: this.unitOfWorkFactory.capabilities.guarantee,
      }
    } catch (error) {
      if (!committed) {
        // A rollback failure must never mask the original error.
        await unitOfWork.rollback().catch(() => undefined)
      }
      throw error
    }
  }

  private async resolveContext(
    unitOfWork: UnitOfWork,
    chequeBookId: string
  ): Promise<{ book: ChequeBook; bankAccountId: string; bankId: string }> {
    const book = await unitOfWork.chequeBooks.findById(chequeBookId)
    if (book === null) {
      throw new EntityNotFoundError('ChequeBook', chequeBookId)
    }

    const account = await unitOfWork.bankAccounts.findById(book.bankAccountId)
    if (account === null) {
      throw new EntityNotFoundError('BankAccount', book.bankAccountId)
    }
    if (!account.isActive) {
      throw new InactiveEntityError('BankAccount', account.id)
    }

    const bank = await unitOfWork.banks.findById(account.bankId)
    if (bank === null) {
      throw new EntityNotFoundError('Bank', account.bankId)
    }
    if (!bank.isActive) {
      throw new InactiveEntityError('Bank', bank.id)
    }

    // Status and exhaustion are checked distinctly so the caller can react differently:
    // a retired/lost book needs replacing, an exhausted one needs the next book opened.
    if (book.sequence.isExhausted) {
      throw new ChequeBookExhaustedError(book.id, book.sequence.endSequence)
    }
    if (book.status !== 'active') {
      throw new ChequeBookNotActiveError(book.id, book.status)
    }

    return { book, bankAccountId: account.id, bankId: bank.id }
  }

  private obtainChequeNumber(
    book: ChequeBook,
    input: IssueChequeInput,
    now: string
  ): { chequeNumber: ChequeNumber; chequeBook: ChequeBook } {
    if (book.isManual) {
      if (input.chequeNumber === undefined || input.chequeNumber === null) {
        throw new ManualNumberRequiredError(book.id)
      }
      const reserved = book.reserveManualChequeNumber(input.chequeNumber, now)
      return { chequeNumber: reserved.chequeNumber, chequeBook: reserved.book }
    }

    if (input.chequeNumber !== undefined && input.chequeNumber !== null) {
      throw new AutomaticNumberNotPermittedError(book.id, book.sequence.sequenceMode)
    }

    const allocated = book.allocateNextChequeNumber(now)
    return { chequeNumber: allocated.chequeNumber, chequeBook: allocated.book }
  }

  private async assertNumberIsFree(
    unitOfWork: UnitOfWork,
    chequeNumber: ChequeNumber,
    chequeBookId: string
  ): Promise<void> {
    // Exact string comparison. Adapters MUST NOT numerically coerce either side.
    if (await unitOfWork.chequeBooks.hasChequeNumber(chequeBookId, chequeNumber.value)) {
      throw new DuplicateChequeNumberError(chequeBookId, chequeNumber.value)
    }
    const existing = await unitOfWork.cheques.findByChequeBookAndNumber(
      chequeBookId,
      chequeNumber.value
    )
    if (existing !== null) {
      throw new DuplicateChequeNumberError(chequeBookId, chequeNumber.value)
    }
  }
}
