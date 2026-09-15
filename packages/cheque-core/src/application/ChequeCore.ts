import { Bank, type CreateBankInput } from '../domain/entities/Bank'
import { BankAccount, type CreateBankAccountInput } from '../domain/entities/BankAccount'
import { ChequeBook, type CreateChequeBookInput } from '../domain/entities/ChequeBook'
import { Cheque } from '../domain/entities/Cheque'
import type { ChequeStatus } from '../domain/lifecycle/ChequeStatus'
import { DefaultCurrencyRegistry, type CurrencyRegistry } from '../domain/value-objects/CurrencyRegistry'
import { EntityNotFoundError } from '../domain/errors'
import { SystemClock, type Clock } from '../ports/Clock'
import type { IdGenerator } from '../ports/IdGenerator'
import { CryptoIdGenerator } from '../infrastructure/ids/CryptoIdGenerator'
import { ChequePersistence, type ChequePersistenceOptions } from '../infrastructure/persistence/ChequePersistence'
import { LocalStorageRecordStore } from '../infrastructure/persistence/LocalStorageRecordStore'
import type {
  PersistenceDiagnostics,
  UnitOfWorkFactory,
} from '../ports/repositories'
import {
  IssueChequeUseCase,
  TRANSACTIONALITY,
  type IssueChequeInput,
  type IssueChequeResult,
} from './IssueChequeUseCase'

export interface ChequeCoreOptions {
  readonly unitOfWorkFactory?: UnitOfWorkFactory
  readonly idGenerator?: IdGenerator
  readonly clock?: Clock
  readonly currencyRegistry?: CurrencyRegistry
}

/**
 * Composition root for the cheque domain.
 *
 * Wires the ports to concrete adapters and exposes the operations a host application
 * needs. It holds NO business rules of its own — every rule lives in the domain entities,
 * the sequence engine or a use case — so the same core can be driven from Vue, from a web
 * component, from a CLI import job or from a test.
 *
 * Nothing here imports Vue, the DOM or a printer.
 *
 * @example
 * ```ts
 * const core = ChequeCore.createInMemory()
 * const bank = await core.createBank({ code: 'NBE', name: 'National Bank of Egypt' })
 * const account = await core.createBankAccount({
 *   bankId: bank.id, holderName: 'Acme', accountNumber: '0012345', currency: 'EGP',
 * })
 * const book = await core.createChequeBook({
 *   bankAccountId: account.id, label: 'Book 1',
 *   sequence: { prefix: 'A', sequenceMode: 'alphanumeric', startSequence: 4567, endSequence: 4666 },
 * })
 * const issued = await core.issueCheque({
 *   chequeBookId: book.id, payeeName: 'Supplier', amount: Money.fromDecimalString('1250.75', 'EGP'),
 * })
 * issued.chequeNumber // 'A4567'
 * ```
 */
export class ChequeCore {
  readonly unitOfWorkFactory: UnitOfWorkFactory
  readonly idGenerator: IdGenerator
  readonly clock: Clock
  readonly currencyRegistry: CurrencyRegistry

  private readonly issueChequeUseCase: IssueChequeUseCase

  constructor(options: ChequeCoreOptions = {}) {
    this.unitOfWorkFactory = options.unitOfWorkFactory ?? new ChequePersistence()
    this.idGenerator = options.idGenerator ?? new CryptoIdGenerator()
    this.clock = options.clock ?? new SystemClock()
    this.currencyRegistry = options.currencyRegistry ?? new DefaultCurrencyRegistry()

    this.issueChequeUseCase = new IssueChequeUseCase({
      unitOfWorkFactory: this.unitOfWorkFactory,
      idGenerator: this.idGenerator,
      clock: this.clock,
    })
  }

  /** Volatile core for tests, demos and ephemeral sessions. Nothing touches disk. */
  static createInMemory(options: Omit<ChequeCoreOptions, 'unitOfWorkFactory'> = {}): ChequeCore {
    return new ChequeCore({ ...options, unitOfWorkFactory: new ChequePersistence() })
  }

  /**
   * Core persisted to `localStorage`, one key per record.
   *
   * @throws LocalStorageUnavailableError when the environment has no usable localStorage.
   */
  static createLocalStorage(
    options: Omit<ChequeCoreOptions, 'unitOfWorkFactory'> & {
      persistence?: ChequePersistenceOptions
    } = {}
  ): ChequeCore {
    const { persistence, ...rest } = options
    return new ChequeCore({
      ...rest,
      unitOfWorkFactory: new ChequePersistence({
        ...persistence,
        store: persistence?.store ?? new LocalStorageRecordStore(),
      }),
    })
  }

  /** The atomicity level writes will run under. See {@link TRANSACTIONALITY}. */
  get transactionGuarantee(): string {
    return this.unitOfWorkFactory.capabilities.guarantee
  }

  /** Plain-language statement of the transactional guarantee, for diagnostics screens. */
  transactionGuaranteeDescription(): string {
    switch (this.unitOfWorkFactory.capabilities.guarantee) {
      case 'atomic':
        return TRANSACTIONALITY.atomic
      case 'best-effort':
        return this.unitOfWorkFactory.capabilities.limitation ?? TRANSACTIONALITY.bestEffort
      case 'none':
        return TRANSACTIONALITY.none
    }
  }

  diagnostics(): PersistenceDiagnostics {
    if (this.unitOfWorkFactory instanceof ChequePersistence) {
      return this.unitOfWorkFactory.diagnostics()
    }
    return {
      adapterName: this.unitOfWorkFactory.constructor.name,
      capabilities: this.unitOfWorkFactory.capabilities,
      lastCommitAt: null,
    }
  }

  // ---------------------------------------------------------------------------
  // Entity creation
  // ---------------------------------------------------------------------------

  /**
   * Create and persist a Bank.
   *
   * `id` is optional: when omitted a cryptographically-random identifier is generated.
   * `createdAt` defaults to the injected clock, which keeps records deterministic in tests.
   */
  async createBank(input: Omit<CreateBankInput, 'id' | 'createdAt'> & { id?: string }): Promise<Bank> {
    const now = this.clock.now()
    const bank = Bank.create({ ...input, id: input.id ?? this.idGenerator.next('bank'), createdAt: now })
    const uow = await this.unitOfWorkFactory.begin()
    try {
      await uow.banks.save(bank)
      await uow.commit()
    } catch (error) {
      await uow.rollback().catch(() => undefined)
      throw error
    }
    return bank
  }

  /**
   * Create and persist a BankAccount under an existing Bank.
   *
   * @throws EntityNotFoundError when the referenced bank does not exist.
   */
  async createBankAccount(
    input: Omit<CreateBankAccountInput, 'id' | 'createdAt'> & { id?: string }
  ): Promise<BankAccount> {
    const now = this.clock.now()
    const uow = await this.unitOfWorkFactory.begin()
    try {
      const bank = await uow.banks.findById(input.bankId)
      if (bank === null) throw new EntityNotFoundError('Bank', input.bankId)

      const account = BankAccount.create({
        ...input,
        id: input.id ?? this.idGenerator.next('bankAccount'),
        createdAt: now,
      })

      await uow.bankAccounts.save(account)
      await uow.commit()
      return account
    } catch (error) {
      await uow.rollback().catch(() => undefined)
      throw error
    }
  }

  /**
   * Create and persist a ChequeBook under an existing BankAccount.
   *
   * The book owns its numbering from this point on: `sequence.startSequence` seeds the
   * cursor and there is no global counter to consult.
   *
   * @throws EntityNotFoundError when the referenced account does not exist.
   */
  async createChequeBook(
    input: Omit<CreateChequeBookInput, 'id' | 'createdAt'> & { id?: string }
  ): Promise<ChequeBook> {
    const now = this.clock.now()
    const uow = await this.unitOfWorkFactory.begin()
    try {
      const account = await uow.bankAccounts.findById(input.bankAccountId)
      if (account === null) throw new EntityNotFoundError('BankAccount', input.bankAccountId)

      const book = ChequeBook.create({
        ...input,
        id: input.id ?? this.idGenerator.next('chequeBook'),
        createdAt: now,
      })

      await uow.chequeBooks.save(book)
      await uow.commit()
      return book
    } catch (error) {
      await uow.rollback().catch(() => undefined)
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // Cheque operations
  // ---------------------------------------------------------------------------

  /**
   * Issue a cheque from a cheque book.
   *
   * The sequence advance and the cheque write are committed in one unit of work.
   * On failure NOTHING is persisted and the error propagates — a failed issuance is never
   * reported as a success.
   */
  async issueCheque(input: IssueChequeInput): Promise<IssueChequeResult> {
    return this.issueChequeUseCase.execute(input)
  }

  /**
   * Move a cheque to a new lifecycle state, appending to its append-only history.
   *
   * @throws InvalidChequeStatusTransitionError when the transition is not permitted.
   * @throws EntityNotFoundError when the cheque does not exist.
   */
  async transitionCheque(
    chequeId: string,
    status: ChequeStatus,
    meta: { reason?: string; actorId?: string } = {}
  ): Promise<Cheque> {
    const occurredAt = this.clock.now()
    const uow = await this.unitOfWorkFactory.begin()
    try {
      const existing = await uow.cheques.findById(chequeId)
      if (existing === null) throw new EntityNotFoundError('Cheque', chequeId)

      const updated = existing.transitionTo(status, { occurredAt, ...meta })
      await uow.cheques.save(updated)
      await uow.commit()
      return updated
    } catch (error) {
      await uow.rollback().catch(() => undefined)
      throw error
    }
  }

  /** Load a cheque by id. */
  async findCheque(chequeId: string): Promise<Cheque | null> {
    const uow = await this.unitOfWorkFactory.begin()
    try {
      return await uow.cheques.findById(chequeId)
    } finally {
      await uow.rollback().catch(() => undefined)
    }
  }

  /** Load a cheque book by id, including its current sequence state. */
  async findChequeBook(chequeBookId: string): Promise<ChequeBook | null> {
    const uow = await this.unitOfWorkFactory.begin()
    try {
      return await uow.chequeBooks.findById(chequeBookId)
    } finally {
      await uow.rollback().catch(() => undefined)
    }
  }
}
